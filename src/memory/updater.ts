/**
 * 结构化记忆更新器 — 从 Nine structured/updater.py 翻译
 *
 * 基于 LLM 的记忆增量更新：
 * load → format → LLM call → parse JSON → apply updates
 */
import OpenAI from 'openai';
import { randomUUID } from 'crypto';

import { getMemoryConfig } from './config.js';
import { getEmbedding } from './embeddings.js';
import {
  enforceMaxFacts,
  loadFacts,
  loadProfile,
  removeFacts,
  saveProfile,
  storeFacts,
} from './storage.js';
import {
  MEMORY_UPDATE_PROMPT,
  formatConversationForUpdate,
  ConversationMessage,
} from './prompt.js';
import { logger } from '../logger.js';

// 匹配文件上传事件相关的句子（从 Nine 直接移植）
const UPLOAD_SENTENCE_RE =
  /[^.!?]*\b(?:upload(?:ed|ing)?(?:\s+\w+){0,3}\s+(?:files?|documents?|attachments?)|file\s+upload|\/mnt\/user-data\/uploads\/|<uploaded_files>)[^.!?]*[.!?]?\s*/gi;

function stripUploadMentions(
  memoryData: Record<string, unknown>,
): Record<string, unknown> {
  for (const section of ['user', 'history']) {
    const sectionData = memoryData[section] as
      | Record<string, { summary?: string }>
      | undefined;
    if (!sectionData) continue;
    for (const val of Object.values(sectionData)) {
      if (val && typeof val.summary === 'string') {
        val.summary = val.summary
          .replace(UPLOAD_SENTENCE_RE, '')
          .replace(/ {2,}/g, ' ')
          .trim();
      }
    }
  }

  const facts = memoryData.facts as Array<{ content?: string }> | undefined;
  if (facts) {
    memoryData.facts = facts.filter(
      (f) => !f.content || !UPLOAD_SENTENCE_RE.test(f.content),
    );
    // Reset lastIndex after test()
    UPLOAD_SENTENCE_RE.lastIndex = 0;
  }

  return memoryData;
}

let _llmClient: OpenAI | null = null;

function getLlmClient(): OpenAI {
  if (_llmClient) return _llmClient;
  const config = getMemoryConfig();
  _llmClient = new OpenAI({
    apiKey: config.dashscopeApiKey,
    baseURL: config.dashscopeBaseUrl,
  });
  return _llmClient;
}

/** 重置 LLM 客户端（测试用） */
export function resetLlmClient(): void {
  _llmClient = null;
}

interface SectionUpdate {
  summary?: string;
  shouldUpdate?: boolean;
}

interface LlmUpdateResponse {
  user?: Record<string, SectionUpdate>;
  history?: Record<string, SectionUpdate>;
  newFacts?: Array<{
    content?: string;
    category?: string;
    confidence?: number;
  }>;
  factsToRemove?: string[];
}

export class MemoryUpdater {
  /**
   * 根据对话消息更新记忆。
   * 返回 true 表示更新成功。
   */
  async updateMemory(
    groupFolder: string,
    messages: ConversationMessage[],
    sessionId?: string,
    userId: string = '',
  ): Promise<boolean> {
    const config = getMemoryConfig();
    if (!config.enabled) return false;
    if (!messages || messages.length === 0) return false;

    try {
      // 加载当前记忆状态
      const profile = loadProfile(groupFolder);
      const existingFacts = loadFacts(groupFolder);

      // 组装 DeerFlow 兼容的 memory_data
      const currentMemory = this.buildMemoryData(profile, existingFacts);

      // 格式化对话
      const conversationText = formatConversationForUpdate(messages);
      if (!conversationText.trim()) return false;

      // 构建 prompt
      const prompt = MEMORY_UPDATE_PROMPT.replace(
        '{current_memory}',
        JSON.stringify(currentMemory, null, 2),
      ).replace('{conversation}', conversationText);

      // 调 LLM
      const client = getLlmClient();
      const response = await client.chat.completions.create({
        model: config.llmModel,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        response_format: { type: 'json_object' },
      });

      let responseText = response.choices[0]?.message?.content?.trim() || '';

      // 去除 markdown code block
      if (responseText.startsWith('```')) {
        const lines = responseText.split('\n');
        responseText = (
          lines[lines.length - 1] === '```'
            ? lines.slice(1, -1)
            : lines.slice(1)
        ).join('\n');
      }

      // 解析 JSON
      let updateData: LlmUpdateResponse;
      try {
        updateData = JSON.parse(responseText);
      } catch {
        // json-repair fallback（可选依赖）
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const mod = (await import('jsonrepair' as any)) as any;
          const jsonrepair = mod.default ?? mod.jsonrepair;
          const repaired = jsonrepair(responseText);
          updateData = JSON.parse(repaired as string);
          logger.info('JSON 通过 jsonrepair 修复成功');
        } catch (repairErr) {
          logger.warn(
            { err: repairErr, text: responseText.slice(0, 200) },
            'JSON 解析失败且修复失败',
          );
          return false;
        }
      }

      // 应用增量更新
      await this.applyUpdates(
        currentMemory,
        updateData,
        groupFolder,
        sessionId,
        userId,
      );
      return true;
    } catch (err) {
      logger.error({ err }, '记忆更新失败');
      return false;
    }
  }

  private buildMemoryData(
    profile: Record<string, unknown> | null,
    existingFacts: Array<{
      id: string;
      content: string;
      category: string;
      confidence: number;
    }>,
  ): Record<string, unknown> {
    const p = profile || {};
    const now = new Date().toISOString();

    return {
      version: '1.0',
      lastUpdated: now,
      user: (p.user as Record<string, unknown>) || {
        workContext: { summary: '', updatedAt: '' },
        personalContext: { summary: '', updatedAt: '' },
        topOfMind: { summary: '', updatedAt: '' },
      },
      history: (p.history as Record<string, unknown>) || {
        recentMonths: { summary: '', updatedAt: '' },
        earlierContext: { summary: '', updatedAt: '' },
        longTermBackground: { summary: '', updatedAt: '' },
      },
      facts: existingFacts.map((f) => ({
        id: f.id,
        content: f.content,
        category: f.category,
        confidence: f.confidence,
      })),
    };
  }

  private async applyUpdates(
    currentMemory: Record<string, unknown>,
    updateData: LlmUpdateResponse,
    groupFolder: string,
    sessionId?: string,
    userId: string = '',
  ): Promise<void> {
    const config = getMemoryConfig();
    const now = new Date().toISOString();

    // 更新 profile sections
    let profileChanged = false;

    const userUpdates = updateData.user || {};
    const currentUser = currentMemory.user as Record<
      string,
      { summary: string; updatedAt: string }
    >;
    for (const section of [
      'workContext',
      'personalContext',
      'topOfMind',
    ] as const) {
      const data = userUpdates[section];
      if (data?.shouldUpdate && data.summary) {
        currentUser[section] = { summary: data.summary, updatedAt: now };
        profileChanged = true;
      }
    }

    const historyUpdates = updateData.history || {};
    const currentHistory = currentMemory.history as Record<
      string,
      { summary: string; updatedAt: string }
    >;
    for (const section of [
      'recentMonths',
      'earlierContext',
      'longTermBackground',
    ] as const) {
      const data = historyUpdates[section];
      if (data?.shouldUpdate && data.summary) {
        currentHistory[section] = { summary: data.summary, updatedAt: now };
        profileChanged = true;
      }
    }

    // 清除上传文件相关内容
    stripUploadMentions(currentMemory);

    if (profileChanged) {
      saveProfile(
        groupFolder,
        {
          user: currentMemory.user as Record<string, unknown>,
          history: currentMemory.history as Record<string, unknown>,
        },
        userId,
      );
    }

    // 删除被否定的 facts
    const factsToRemove = updateData.factsToRemove || [];
    if (factsToRemove.length > 0) {
      removeFacts(factsToRemove);
    }

    // 添加新 facts
    const newFacts = updateData.newFacts || [];
    const factsToStore: Array<{
      id: string;
      content: string;
      category: string;
      confidence: number;
      source: string;
    }> = [];

    for (const fact of newFacts) {
      const confidence = fact.confidence ?? 0.5;
      if (confidence < config.factConfidenceThreshold) continue;

      const content = (fact.content || '').trim();
      if (!content) continue;

      // 清除上传相关 fact
      UPLOAD_SENTENCE_RE.lastIndex = 0;
      if (UPLOAD_SENTENCE_RE.test(content)) continue;

      factsToStore.push({
        id: randomUUID(),
        content,
        category: fact.category || 'context',
        confidence,
        source: sessionId || 'unknown',
      });
    }

    if (factsToStore.length > 0) {
      await storeFacts(groupFolder, factsToStore, userId);
    }

    // 超限清理
    enforceMaxFacts(groupFolder, undefined, userId);
  }
}
