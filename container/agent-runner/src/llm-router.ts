/**
 * LLM Router - Determines which provider to use based on query complexity
 */

export interface LLMProviderConfig {
  type: 'claude' | 'openai-compatible';

  // OpenAI-compatible settings
  baseUrl?: string;
  model?: string;
  apiKey?: string;

  // Routing strategy
  routingMode?: 'always' | 'simple' | 'manual' | 'hybrid';
  maxTokensForLocal?: number;
  allowToolUse?: boolean;
}

export interface ProviderChoice {
  type: 'claude' | 'local';
  reason: string;
  config?: LLMProviderConfig;
}

// Keywords that indicate tool use is needed
const TOOL_KEYWORDS = [
  'search', 'browse', 'web', 'fetch', 'url', 'website',
  'schedule', 'remind', 'task', 'cron', 'timer',
  'file', 'read', 'write', 'edit', 'folder', 'directory',
  'bash', 'command', 'run', 'execute', 'script', 'shell',
  'agent-browser', 'screenshot', 'click', 'navigate', 'page',
  'install', 'npm', 'git', 'docker', 'build',
];

/**
 * Estimates token count using word-based heuristic
 * More accurate than character count, less expensive than tiktoken
 */
export function estimateTokens(text: string): number {
  const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
  return Math.ceil(wordCount * 1.3); // Rough approximation: 1 word ≈ 1.3 tokens
}

/**
 * Checks if the prompt contains keywords that suggest tool use
 */
export function needsTools(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return TOOL_KEYWORDS.some(kw => lower.includes(kw));
}

/**
 * Checks for manual routing prefix (@local or @claude)
 */
export function checkManualRouting(prompt: string): 'local' | 'claude' | null {
  const trimmed = prompt.trim();
  if (trimmed.startsWith('@local ')) return 'local';
  if (trimmed.startsWith('@claude ')) return 'claude';
  return null;
}

/**
 * Removes manual routing prefix from prompt
 */
export function stripRoutingPrefix(prompt: string): string {
  const trimmed = prompt.trim();
  if (trimmed.startsWith('@local ')) return trimmed.slice(7);
  if (trimmed.startsWith('@claude ')) return trimmed.slice(8);
  return prompt;
}

/**
 * Main routing function - determines which LLM provider to use
 */
export function routeQuery(
  prompt: string,
  config: LLMProviderConfig | undefined,
  sessionTurnCount: number = 0,
): ProviderChoice {
  // Default to Claude if no config
  if (!config || config.type === 'claude') {
    return { type: 'claude', reason: 'Default provider (no LLM config)' };
  }

  const routingMode = config.routingMode || 'simple';
  const maxTokens = config.maxTokensForLocal || 500;

  // Mode: always - use configured provider exclusively
  if (routingMode === 'always') {
    return {
      type: 'local',
      reason: 'Routing mode: always use local',
      config,
    };
  }

  // Mode: manual - check for routing prefix
  if (routingMode === 'manual') {
    const manualChoice = checkManualRouting(prompt);
    if (manualChoice === 'local') {
      return {
        type: 'local',
        reason: 'Manual routing: @local prefix',
        config,
      };
    }
    if (manualChoice === 'claude') {
      return { type: 'claude', reason: 'Manual routing: @claude prefix' };
    }
    // No prefix in manual mode = use Claude as default
    return { type: 'claude', reason: 'Manual mode: no routing prefix, defaulting to Claude' };
  }

  // Mode: simple - heuristic-based routing
  if (routingMode === 'simple') {
    // Estimate tokens
    const tokens = estimateTokens(prompt);
    if (tokens > maxTokens) {
      return { type: 'claude', reason: `Query too long: ${tokens} tokens > ${maxTokens}` };
    }

    // Check for tool keywords
    if (needsTools(prompt)) {
      return { type: 'claude', reason: 'Query contains tool keywords' };
    }

    // Check conversation depth (multi-turn conversations stay with Claude)
    if (sessionTurnCount > 3) {
      return { type: 'claude', reason: `Conversation depth: ${sessionTurnCount} turns` };
    }

    // All checks passed - use local LLM
    return {
      type: 'local',
      reason: `Simple query: ${tokens} tokens, no tools, ${sessionTurnCount} turns`,
      config,
    };
  }

  // Mode: hybrid - use Claude to classify (not implemented yet)
  if (routingMode === 'hybrid') {
    // TODO: Make meta-call to Claude to classify complexity
    // For now, fall back to simple mode
    return routeQuery(prompt, { ...config, routingMode: 'simple' }, sessionTurnCount);
  }

  // Fallback
  return { type: 'claude', reason: 'Unknown routing mode, defaulting to Claude' };
}
