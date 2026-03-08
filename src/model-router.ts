/**
 * Model Router for NanoClaw
 *
 * Classifies incoming messages by complexity and routes them to the
 * appropriate model tier:
 *
 *   SIMPLE   → Groq API (free) or Gemini Flash (free fallback)
 *   MODERATE → claude -p --model haiku
 *   COMPLEX  → claude -p --model sonnet
 *   EXPERT   → claude -p --model opus
 *
 * The classifier is purely rule-based (zero cost, <1ms).
 * Free-tier calls bypass claude -p entirely.
 */
import { logger } from './logger.js';

// ── Types ────────────────────────────────────────────────────

export type ModelTier = 'simple' | 'moderate' | 'complex' | 'expert';

export type EffortLevel = 'low' | 'medium' | 'high';

export interface RouteResult {
  tier: ModelTier;
  /** Claude model alias (haiku/sonnet/opus) — undefined for simple tier */
  model?: string;
  /** Claude --effort flag (low/medium/high) — controls thinking budget */
  effort: EffortLevel;
  /** If true, use free API instead of claude -p */
  useFreeModel: boolean;
  /** Reason the classifier chose this tier (for logging) */
  reason: string;
}

export interface FreeModelResponse {
  text: string;
  model: string;
  provider: string;
  latencyMs: number;
}

// ── Configuration ────────────────────────────────────────────

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent';

// NEO's system prompt for free-tier models (compact — they don't need full context)
const NEO_FREE_SYSTEM_PROMPT = `You are NEO, Andrea Feo's personal AI assistant. You communicate in Italian.
Andrea is an entrepreneur and AI/tech consultant based in Milan. He founded Kosmoy (AI governance SaaS) and Aibilia (AI consultancy).
You run on NanoClaw, an agent framework on a Hetzner server.
Keep responses concise and natural. You're chatting on Discord.
Use Discord formatting: **bold**, *italic*, \`code\`. No markdown headings.
If the user asks something that requires searching code, files, or deep analysis, tell them you'll need to switch to a more powerful mode and suggest they ask again with more detail.`;

// ── Effort Mapping ──────────────────────────────────────────
// Default effort per tier (thinking budget)
const TIER_EFFORT: Record<ModelTier, EffortLevel> = {
  simple: 'low',
  moderate: 'medium',
  complex: 'high',
  expert: 'high',
};

// ── Metatag Parser ──────────────────────────────────────────
// Structured metatags: <neo:key=value>
// Examples: <neo:model=opus>, <neo:effort=high>, <neo:tier=complex>
interface MetaTagOverrides {
  model?: string;
  effort?: EffortLevel;
  tier?: ModelTier;
}

function parseMetaTags(text: string): MetaTagOverrides {
  const overrides: MetaTagOverrides = {};
  const tagPattern = /<neo:(\w+)=(\w+)>/gi;
  let match;
  while ((match = tagPattern.exec(text)) !== null) {
    const [, key, value] = match;
    switch (key.toLowerCase()) {
      case 'model':
        if (['haiku', 'sonnet', 'opus'].includes(value.toLowerCase())) {
          overrides.model = value.toLowerCase();
        }
        break;
      case 'effort':
        if (['low', 'medium', 'high'].includes(value.toLowerCase())) {
          overrides.effort = value.toLowerCase() as EffortLevel;
        }
        break;
      case 'tier':
        if (['simple', 'moderate', 'complex', 'expert'].includes(value.toLowerCase())) {
          overrides.tier = value.toLowerCase() as ModelTier;
        }
        break;
    }
  }
  return overrides;
}

function stripMetaTags(text: string): string {
  return text.replace(/<neo:\w+=\w+>/gi, '').trim();
}

// ── Classifier ───────────────────────────────────────────────

// User override prefixes — highest priority
const MODEL_OVERRIDES: Record<string, { tier: ModelTier; model: string }> = {
  '/haiku': { tier: 'moderate', model: 'haiku' },
  '/sonnet': { tier: 'complex', model: 'sonnet' },
  '/opus': { tier: 'expert', model: 'opus' },
};

// Keywords that push toward COMPLEX tier
const COMPLEX_KEYWORDS_IT = [
  'analizza', 'analisi', 'implementa', 'implementare', 'refactora', 'refactoring',
  'debug', 'debugga', 'confronta', 'confronto', 'progetta', 'progettare',
  'review', 'rivedi', 'migliora', 'ottimizza', 'correggi', 'sistema',
  'modifica il codice', 'scrivi il codice', 'crea un', 'costruisci',
  'fix', 'bug', 'errore nel codice', 'non funziona',
  'pull request', 'commit', 'merge', 'deploy',
];

const COMPLEX_KEYWORDS_EN = [
  'analyze', 'implement', 'refactor', 'debug', 'compare', 'design',
  'review', 'improve', 'optimize', 'fix', 'build', 'create',
  'write code', 'modify code', 'pull request',
];

// Keywords that push toward EXPERT tier
const EXPERT_KEYWORDS = [
  'architettura', 'architecture', 'design system', 'strategia', 'strategy',
  'analisi approfondita', 'deep analysis', 'audit completo', 'full audit',
  'usa opus', 'use opus', 'massima qualità',
  'riprogetta', 'redesign', 'sistema completo',
];

// Keywords indicating the message needs tool access (KB search, file ops)
const TOOL_KEYWORDS = [
  'cerca', 'search', 'knowledge', 'codebase', 'file', 'progetto', 'project',
  'codice', 'code', 'repository', 'repo', 'git', 'database', 'server',
  'kosmoy', 'nanoclaw', 'neo-trading', 'dashboard',
  'leggi', 'scrivi', 'modifica', 'apri', 'controlla', 'verifica',
  'cosa sai', 'dimmi di', 'parlami di', 'spiegami',
];

// Simple greetings / acknowledgments (keep in free tier)
const SIMPLE_PATTERNS = [
  /^(ciao|hey|hi|hello|buongiorno|buonasera|salve)\b/i,
  /^(ok|va bene|perfetto|grazie|thanks|capito|inteso)\b/i,
  /^(come stai|how are you|tutto bene)\??$/i,
  /^(sì|si|no|nope|nah)\b/i,
  /^(lol|haha|😂|👍|🙏|❤️)/i,
];

/**
 * Extract the raw user message text from the XML-formatted prompt.
 * NanoClaw wraps messages in <messages><message>...</message></messages>.
 */
function extractUserText(prompt: string): string {
  // Extract content from the last <message ...> tag (the most recent user message)
  // Note: must use "<message " (with space) to avoid matching "<messages>" wrapper
  const matches = [...prompt.matchAll(/<message\s[^>]*>([\s\S]*?)<\/message>/g)];
  if (matches.length > 0) {
    return matches[matches.length - 1][1].trim();
  }
  return prompt.trim();
}

/**
 * Classify a message into a model tier + effort level.
 * Pure rule-based, zero cost, <1ms.
 *
 * Priority:
 *   1. Metatags (<neo:model=opus>, <neo:effort=high>, <neo:tier=complex>)
 *   2. Slash prefixes (/haiku, /sonnet, /opus)
 *   3. Keyword classification
 *   4. Length heuristics
 *   5. Default → moderate/haiku/medium
 */
export function classifyTier(prompt: string): RouteResult {
  const rawText = extractUserText(prompt);

  // 0. Parse metatags FIRST (highest priority, used by programmatic callers)
  const metaTags = parseMetaTags(rawText);
  const text = stripMetaTags(rawText);
  const lower = text.toLowerCase();
  const wordCount = text.split(/\s+/).length;

  // If metatags specify a full override, use it directly
  if (metaTags.tier || metaTags.model) {
    const tier = metaTags.tier || (metaTags.model === 'opus' ? 'expert' : metaTags.model === 'sonnet' ? 'complex' : 'moderate');
    return {
      tier,
      model: metaTags.model || (tier === 'expert' ? 'opus' : tier === 'complex' ? 'sonnet' : 'haiku'),
      effort: metaTags.effort || TIER_EFFORT[tier],
      useFreeModel: false,
      reason: `metatag override: ${Object.entries(metaTags).map(([k, v]) => `${k}=${v}`).join(', ')}`,
    };
  }

  // 1. Check user slash overrides (/haiku, /sonnet, /opus)
  for (const [prefix, override] of Object.entries(MODEL_OVERRIDES)) {
    if (lower.startsWith(prefix)) {
      return {
        tier: override.tier,
        model: override.model,
        effort: metaTags.effort || TIER_EFFORT[override.tier],
        useFreeModel: false,
        reason: `user override: ${prefix}`,
      };
    }
  }

  // 2. Check for EXPERT keywords
  if (EXPERT_KEYWORDS.some((kw) => lower.includes(kw))) {
    return {
      tier: 'expert',
      model: 'opus',
      effort: metaTags.effort || 'high',
      useFreeModel: false,
      reason: 'expert keyword match',
    };
  }

  // 3. Check for COMPLEX keywords
  const complexMatches = [
    ...COMPLEX_KEYWORDS_IT.filter((kw) => lower.includes(kw)),
    ...COMPLEX_KEYWORDS_EN.filter((kw) => lower.includes(kw)),
  ];
  if (complexMatches.length > 0) {
    return {
      tier: 'complex',
      model: 'sonnet',
      effort: metaTags.effort || 'high',
      useFreeModel: false,
      reason: `complex keywords: ${complexMatches.slice(0, 3).join(', ')}`,
    };
  }

  // 4. Long messages (> 500 chars or > 80 words) → complex
  if (text.length > 500 || wordCount > 80) {
    return {
      tier: 'complex',
      model: 'sonnet',
      effort: metaTags.effort || 'high',
      useFreeModel: false,
      reason: `long message (${text.length} chars, ${wordCount} words)`,
    };
  }

  // 5. Check if message needs tool access (KB, files, code)
  if (TOOL_KEYWORDS.some((kw) => lower.includes(kw))) {
    return {
      tier: 'moderate',
      model: 'haiku',
      effort: metaTags.effort || 'medium',
      useFreeModel: false,
      reason: 'needs tool access (KB/file/code reference)',
    };
  }

  // 6. Check for simple patterns (greetings, acks)
  if (SIMPLE_PATTERNS.some((p) => p.test(text)) && wordCount <= 15) {
    return {
      tier: 'simple',
      effort: metaTags.effort || 'low',
      useFreeModel: true,
      reason: 'simple greeting/acknowledgment',
    };
  }

  // 7. Very short messages without technical content → simple
  if (wordCount <= 8 && text.length < 60) {
    return {
      tier: 'simple',
      effort: metaTags.effort || 'low',
      useFreeModel: true,
      reason: `short message (${wordCount} words)`,
    };
  }

  // 8. Default → moderate (haiku, medium effort)
  return {
    tier: 'moderate',
    model: 'haiku',
    effort: metaTags.effort || 'medium',
    useFreeModel: false,
    reason: 'default tier',
  };
}

// ── Free Model Clients ───────────────────────────────────────

/**
 * Call Groq API (OpenAI-compatible). Free tier.
 */
async function callGroq(userMessage: string): Promise<FreeModelResponse> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  const t0 = Date.now();
  const resp = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: NEO_FREE_SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      max_tokens: 1024,
      temperature: 0.7,
    }),
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`Groq API error ${resp.status}: ${errorText.slice(0, 200)}`);
  }

  const data = await resp.json() as {
    choices: Array<{ message: { content: string } }>;
    model: string;
  };

  return {
    text: data.choices[0]?.message?.content || '',
    model: data.model || GROQ_MODEL,
    provider: 'groq',
    latencyMs: Date.now() - t0,
  };
}

/**
 * Call Google Gemini API. Free tier fallback.
 */
async function callGemini(userMessage: string): Promise<FreeModelResponse> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const t0 = Date.now();
  const url = `${GEMINI_API_URL}?key=${apiKey}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: NEO_FREE_SYSTEM_PROMPT }],
      },
      contents: [{
        role: 'user',
        parts: [{ text: userMessage }],
      }],
      generationConfig: {
        maxOutputTokens: 1024,
        temperature: 0.7,
      },
    }),
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`Gemini API error ${resp.status}: ${errorText.slice(0, 200)}`);
  }

  const data = await resp.json() as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
  };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return {
    text,
    model: 'gemini-2.5-flash-lite',
    provider: 'gemini',
    latencyMs: Date.now() - t0,
  };
}

/**
 * Call a free model. Tries Groq first, falls back to Gemini.
 */
export async function callFreeModel(userMessage: string): Promise<FreeModelResponse> {
  // Try Groq first (faster, more generous free tier)
  try {
    const result = await callGroq(userMessage);
    logger.info(
      { provider: 'groq', model: result.model, latencyMs: result.latencyMs },
      'Free model response',
    );
    return result;
  } catch (err) {
    logger.warn({ err }, 'Groq failed, trying Gemini fallback');
  }

  // Fallback to Gemini
  try {
    const result = await callGemini(userMessage);
    logger.info(
      { provider: 'gemini', model: result.model, latencyMs: result.latencyMs },
      'Free model response (fallback)',
    );
    return result;
  } catch (err) {
    logger.error({ err }, 'All free models failed');
    throw new Error('All free model providers failed');
  }
}
