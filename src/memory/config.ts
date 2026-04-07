/**
 * 结构化记忆配置 — 从 Nine structured/config.py 翻译
 *
 * 所有配置通过 readEnvFile() 读取，与 NanoClaw 其他配置一致。
 */
import { readEnvFile } from '../env.js';

export interface MemoryConfig {
  enabled: boolean;
  debounceSeconds: number;
  maxFacts: number;
  factConfidenceThreshold: number;
  injectionEnabled: boolean;
  maxInjectionTokens: number;
  embeddingDims: number;
  dashscopeApiKey: string;
  dashscopeBaseUrl: string;
  embeddingModel: string;
  llmModel: string;
}

let _config: MemoryConfig | null = null;

export function getMemoryConfig(): MemoryConfig {
  if (_config) return _config;
  _config = loadMemoryConfig();
  return _config;
}

/** 重置配置（测试用） */
export function resetMemoryConfig(): void {
  _config = null;
}

function loadMemoryConfig(): MemoryConfig {
  const env = readEnvFile([
    'MEMORY_ENABLED',
    'MEMORY_DEBOUNCE_SECONDS',
    'MEMORY_MAX_FACTS',
    'MEMORY_FACT_CONFIDENCE_THRESHOLD',
    'MEMORY_MAX_INJECTION_TOKENS',
    'MEMORY_INJECTION_ENABLED',
    'MEMORY_EMBEDDING_DIMS',
    'DASHSCOPE_API_KEY',
    'DASHSCOPE_BASE_URL',
    'MEMORY_EMBEDDING_MODEL',
    'MEMORY_LLM_MODEL',
  ]);

  const apiKey = env.DASHSCOPE_API_KEY || '';
  const enabledRaw = env.MEMORY_ENABLED || 'false';

  // auto 模式：有 DASHSCOPE_API_KEY 时自动启用
  let enabled: boolean;
  if (enabledRaw === 'auto') {
    enabled = !!apiKey;
  } else {
    enabled = enabledRaw === 'true' || enabledRaw === '1';
  }

  return {
    enabled,
    debounceSeconds: parseInt(env.MEMORY_DEBOUNCE_SECONDS || '30', 10),
    maxFacts: parseInt(env.MEMORY_MAX_FACTS || '0', 10), // 0 = 不限制
    factConfidenceThreshold: parseFloat(
      env.MEMORY_FACT_CONFIDENCE_THRESHOLD || '0.7',
    ),
    injectionEnabled:
      (env.MEMORY_INJECTION_ENABLED || 'true') === 'true' ||
      env.MEMORY_INJECTION_ENABLED === '1',
    maxInjectionTokens: parseInt(env.MEMORY_MAX_INJECTION_TOKENS || '1500', 10),
    embeddingDims: parseInt(env.MEMORY_EMBEDDING_DIMS || '1024', 10),
    dashscopeApiKey: apiKey,
    dashscopeBaseUrl:
      env.DASHSCOPE_BASE_URL ||
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    embeddingModel: env.MEMORY_EMBEDDING_MODEL || 'text-embedding-v4',
    llmModel: env.MEMORY_LLM_MODEL || 'qwen3.6-plus',
  };
}
