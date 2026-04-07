/**
 * 记忆 Prompt 模板 — 从 Nine structured/prompt.py 翻译
 *
 * 包含 MEMORY_UPDATE_PROMPT + formatMemoryForInjection + formatConversationForUpdate
 */
import { getMemoryConfig } from './config.js';

// LLM 记忆更新提示词（从 DeerFlow/Nine 直接移植）
export const MEMORY_UPDATE_PROMPT = `You are a memory management system. Your task is to analyze a conversation and update the user's memory profile.

Current Memory State:
<current_memory>
{current_memory}
</current_memory>

New Conversation to Process:
<conversation>
{conversation}
</conversation>

Instructions:
1. Analyze the conversation for important information about the user
2. Extract relevant facts, preferences, and context with specific details (numbers, names, technologies)
3. Update the memory sections as needed following the detailed length guidelines below

Memory Section Guidelines:

**User Context** (Current state - concise summaries):
- workContext: Professional role, company, key projects, main technologies (2-3 sentences)
  Example: Core contributor, project names with metrics (16k+ stars), technical stack
- personalContext: Languages, communication preferences, key interests (1-2 sentences)
  Example: Bilingual capabilities, specific interest areas, expertise domains
- topOfMind: Multiple ongoing focus areas and priorities (3-5 sentences, detailed paragraph)
  Example: Primary project work, parallel technical investigations, ongoing learning/tracking
  Include: Active implementation work, troubleshooting issues, market/research interests
  Note: This captures SEVERAL concurrent focus areas, not just one task

**History** (Temporal context - rich paragraphs):
- recentMonths: Detailed summary of recent activities (4-6 sentences or 1-2 paragraphs)
  Timeline: Last 1-3 months of interactions
  Include: Technologies explored, projects worked on, problems solved, interests demonstrated
- earlierContext: Important historical patterns (3-5 sentences or 1 paragraph)
  Timeline: 3-12 months ago
  Include: Past projects, learning journeys, established patterns
- longTermBackground: Persistent background and foundational context (2-4 sentences)
  Timeline: Overall/foundational information
  Include: Core expertise, longstanding interests, fundamental working style

**Facts Extraction**:
- Extract specific, quantifiable details (e.g., "16k+ GitHub stars", "200+ datasets")
- Include proper nouns (company names, project names, technology names)
- Preserve technical terminology and version numbers
- Categories:
  * preference: Tools, styles, approaches user prefers/dislikes
  * knowledge: Specific expertise, technologies mastered, domain knowledge
  * context: Background facts (job title, projects, locations, languages)
  * behavior: Working patterns, communication habits, problem-solving approaches
  * goal: Stated objectives, learning targets, project ambitions
- Confidence levels:
  * 0.9-1.0: Explicitly stated facts ("I work on X", "My role is Y")
  * 0.7-0.8: Strongly implied from actions/discussions
  * 0.5-0.6: Inferred patterns (use sparingly, only for clear patterns)

**What Goes Where**:
- workContext: Current job, active projects, primary tech stack
- personalContext: Languages, personality, interests outside direct work tasks
- topOfMind: Multiple ongoing priorities and focus areas user cares about recently (gets updated most frequently)
  Should capture 3-5 concurrent themes: main work, side explorations, learning/tracking interests
- recentMonths: Detailed account of recent technical explorations and work
- earlierContext: Patterns from slightly older interactions still relevant
- longTermBackground: Unchanging foundational facts about the user

**Multilingual Content**:
- Preserve original language for proper nouns and company names
- Keep technical terms in their original form (DeepSeek, LangGraph, etc.)
- Note language capabilities in personalContext

Output Format (JSON):
{{
  "user": {{
    "workContext": {{ "summary": "...", "shouldUpdate": true/false }},
    "personalContext": {{ "summary": "...", "shouldUpdate": true/false }},
    "topOfMind": {{ "summary": "...", "shouldUpdate": true/false }}
  }},
  "history": {{
    "recentMonths": {{ "summary": "...", "shouldUpdate": true/false }},
    "earlierContext": {{ "summary": "...", "shouldUpdate": true/false }},
    "longTermBackground": {{ "summary": "...", "shouldUpdate": true/false }}
  }},
  "newFacts": [
    {{ "content": "...", "category": "preference|knowledge|context|behavior|goal", "confidence": 0.0-1.0 }}
  ],
  "factsToRemove": ["fact_id_1", "fact_id_2"]
}}

Important Rules:
- Only set shouldUpdate=true if there's meaningful new information
- Follow length guidelines: workContext/personalContext are concise (1-3 sentences), topOfMind and history sections are detailed (paragraphs)
- Include specific metrics, version numbers, and proper nouns in facts
- Only add facts that are clearly stated (0.9+) or strongly implied (0.7+)
- Remove facts that are contradicted by new information
- When updating topOfMind, integrate new focus areas while removing completed/abandoned ones
  Keep 3-5 concurrent focus themes that are still active and relevant
- For history sections, integrate new information chronologically into appropriate time period
- Preserve technical accuracy - keep exact names of technologies, companies, projects
- Focus on information useful for future interactions and personalization
- IMPORTANT: Do NOT record file upload events in memory. Uploaded files are
  session-specific and ephemeral - they will not be accessible in future sessions.
  Recording upload events causes confusion in subsequent conversations.

Return ONLY valid JSON, no explanation or markdown.`;

/**
 * token 估算：字符数 / 4（不引入 tiktoken 依赖）
 */
function countTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function clampConfidence(value: unknown): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

interface MemorySection {
  summary?: string;
  updatedAt?: string;
}

export interface MemoryData {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  user?: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  history?: Record<string, any>;
  facts?: Array<{
    id?: string;
    content?: string;
    category?: string;
    confidence?: number;
  }>;
}

/**
 * 将记忆数据格式化为 system prompt 注入文本
 */
export function formatMemoryForInjection(
  memoryData: MemoryData,
  maxTokens?: number,
): string {
  if (!memoryData) return '';
  const config = getMemoryConfig();
  const limit = maxTokens ?? config.maxInjectionTokens;

  const sections: string[] = [];

  // User Context
  const user = memoryData.user;
  if (user) {
    const lines: string[] = [];
    const work = user.workContext;
    if (work?.summary) lines.push(`Work: ${work.summary}`);
    const personal = user.personalContext;
    if (personal?.summary) lines.push(`Personal: ${personal.summary}`);
    const topOfMind = user.topOfMind;
    if (topOfMind?.summary) lines.push(`Current Focus: ${topOfMind.summary}`);
    if (lines.length > 0) {
      sections.push('User Context:\n' + lines.map((l) => `- ${l}`).join('\n'));
    }
  }

  // History
  const history = memoryData.history;
  if (history) {
    const lines: string[] = [];
    const recent = history.recentMonths;
    if (recent?.summary) lines.push(`Recent: ${recent.summary}`);
    const earlier = history.earlierContext;
    if (earlier?.summary) lines.push(`Earlier: ${earlier.summary}`);
    if (lines.length > 0) {
      sections.push('History:\n' + lines.map((l) => `- ${l}`).join('\n'));
    }
  }

  // Facts（按置信度降序，在 token 预算内填充）
  const facts = memoryData.facts;
  if (Array.isArray(facts) && facts.length > 0) {
    const ranked = facts
      .filter((f) => f && typeof f.content === 'string' && f.content.trim())
      .sort(
        (a, b) => clampConfidence(b.confidence) - clampConfidence(a.confidence),
      );

    const baseText = sections.join('\n\n');
    const baseTokens = baseText ? countTokens(baseText) : 0;
    const factsHeader = 'Facts:\n';
    const separatorTokens = baseText
      ? countTokens('\n\n' + factsHeader)
      : countTokens(factsHeader);
    let runningTokens = baseTokens + separatorTokens;

    const factLines: string[] = [];
    for (const fact of ranked) {
      const content = fact.content!.trim();
      const category = (fact.category || 'context').trim() || 'context';
      const confidence = clampConfidence(fact.confidence);
      const line = `- [${category} | ${confidence.toFixed(2)}] ${content}`;

      const lineText = factLines.length > 0 ? '\n' + line : line;
      const lineTokens = countTokens(lineText);

      if (runningTokens + lineTokens <= limit) {
        factLines.push(line);
        runningTokens += lineTokens;
      } else {
        break;
      }
    }

    if (factLines.length > 0) {
      sections.push('Facts:\n' + factLines.join('\n'));
    }
  }

  if (sections.length === 0) return '';

  let result = sections.join('\n\n');

  // 最终 token 检查
  const tokenCount = countTokens(result);
  if (tokenCount > limit) {
    const charPerToken = result.length / tokenCount;
    const targetChars = Math.floor(limit * charPerToken * 0.95);
    result = result.slice(0, targetChars) + '\n...';
  }

  return result;
}

export interface ConversationMessage {
  content: string;
  sender_name?: string;
  is_bot_message?: boolean;
  is_from_me?: boolean;
}

/**
 * 将对话消息格式化为记忆更新 prompt 的输入。
 * 遵循 R5.3 消息字段映射。
 */
export function formatConversationForUpdate(
  messages: ConversationMessage[],
): string {
  const lines: string[] = [];

  for (const msg of messages) {
    let content =
      typeof msg.content === 'string' ? msg.content : String(msg.content);

    // 清除上传文件标签
    content = content
      .replace(/<uploaded_files>[\s\S]*?<\/uploaded_files>\n*/g, '')
      .trim();
    if (!content) continue;

    // 截断过长消息
    if (content.length > 1000) {
      content = content.slice(0, 1000) + '...';
    }

    // R5.3: is_bot_message === true 或 is_from_me === true → Assistant
    if (msg.is_bot_message || msg.is_from_me) {
      lines.push(`Assistant: ${content}`);
    } else {
      const name = msg.sender_name || 'User';
      lines.push(`User (${name}): ${content}`);
    }
  }

  return lines.join('\n\n');
}
