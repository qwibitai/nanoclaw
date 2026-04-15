import { describe, it, expect } from 'vitest';
import { resolveModel, LlmConfig } from './provider.js';

describe('resolveModel', () => {
  it('defaults to anthropic with null model when no config', () => {
    const result = resolveModel({});
    expect(result).toEqual({
      provider: 'anthropic',
      model: null,
      providerBaseUrl: null,
    });
  });

  it('uses group config when provided', () => {
    const llm: LlmConfig = {
      provider: 'openai',
      model: 'gpt-4o-mini',
    };
    const result = resolveModel({ llm });
    expect(result).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
      providerBaseUrl: null,
    });
  });

  it('override takes precedence over group config', () => {
    const llm: LlmConfig = {
      provider: 'openai',
      model: 'gpt-4o-mini',
    };
    const result = resolveModel({ llm }, { provider: 'google', model: 'gemini-2.0-flash' });
    expect(result).toEqual({
      provider: 'google',
      model: 'gemini-2.0-flash',
      providerBaseUrl: null,
    });
  });

  it('preserves providerBaseUrl from group config', () => {
    const llm: LlmConfig = {
      provider: 'ollama',
      model: 'llama3:70b',
      providerBaseUrl: 'http://localhost:11434/v1',
    };
    const result = resolveModel({ llm });
    expect(result).toEqual({
      provider: 'ollama',
      model: 'llama3:70b',
      providerBaseUrl: 'http://localhost:11434/v1',
    });
  });

  it('partial override merges with group config', () => {
    const llm: LlmConfig = {
      provider: 'openai',
      model: 'gpt-4o-mini',
    };
    const result = resolveModel({ llm }, { model: 'gpt-4o' });
    expect(result).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
      providerBaseUrl: null,
    });
  });
});
