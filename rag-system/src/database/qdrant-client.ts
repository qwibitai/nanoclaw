import { createHash } from 'crypto';
import { QdrantClient } from '@qdrant/js-client-rest';
import { getConfig } from '../config.js';

export interface MessagePayload {
  [key: string]: unknown;
  message_id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  group_name?: string;
}

export interface MessageEmbedding {
  id: string;
  vector: number[];
  payload: MessagePayload;
}

/**
 * Convert a composite key (message_id + chat_jid) to a UUID-format string.
 * Qdrant requires UUID or unsigned integer IDs. NanoClaw message IDs are
 * hex strings like "3A3515214912AEAD7307", so we hash the composite key
 * to produce a stable UUID.
 */
export function messageIdToUuid(messageId: string, chatJid: string): string {
  const hash = createHash('md5')
    .update(`${messageId}:${chatJid}`)
    .digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join('-');
}

class QdrantClientWrapper {
  private client: QdrantClient | null = null;
  private collectionName: string = '';
  private initialized: boolean = false;

  private getClient(): QdrantClient {
    if (!this.client) {
      const config = getConfig();
      this.client = new QdrantClient({ url: config.qdrant.url });
      this.collectionName = config.qdrant.collection;
    }
    return this.client;
  }

  async initializeCollection(): Promise<void> {
    if (this.initialized) return;

    const config = getConfig();

    try {
      const client = this.getClient();
      const collections = await client.getCollections();
      const exists = collections.collections.some(
        (c) => c.name === this.collectionName
      );

      if (!exists) {
        await client.createCollection(this.collectionName, {
          vectors: {
            size: config.qdrant.vectorSize,
            distance: config.qdrant.distance,
          },
          optimizers_config: {
            indexing_threshold: 100,
          },
        });

        await client.createPayloadIndex(this.collectionName, {
          field_name: 'chat_jid',
          field_schema: 'keyword',
        });

        await client.createPayloadIndex(this.collectionName, {
          field_name: 'sender',
          field_schema: 'keyword',
        });

        await client.createPayloadIndex(this.collectionName, {
          field_name: 'timestamp',
          field_schema: 'datetime',
        });

        await client.createPayloadIndex(this.collectionName, {
          field_name: 'group_name',
          field_schema: 'keyword',
        });

        console.log(`Created Qdrant collection: ${this.collectionName}`);
      } else {
        console.log(`Qdrant collection exists: ${this.collectionName}`);
      }

      this.initialized = true;
    } catch (error) {
      console.error('Error initializing Qdrant collection:', error);
      throw error;
    }
  }

  async upsertEmbeddings(embeddings: MessageEmbedding[]): Promise<void> {
    await this.initializeCollection();

    const points = embeddings.map((emb) => ({
      id: emb.id,
      vector: emb.vector,
      payload: emb.payload,
    }));

    await this.getClient().upsert(this.collectionName, {
      wait: true,
      points,
    });
  }

  async searchSimilar(
    queryVector: number[],
    filters?: {
      chat_jid?: string | string[];
      sender?: string | string[];
      group_name?: string | string[];
      startDate?: string;
      endDate?: string;
    },
    limit: number = 10,
    scoreThreshold?: number
  ): Promise<Array<{ id: string; score: number; payload: any }>> {
    await this.initializeCollection();

    const must: any[] = [];

    if (filters?.chat_jid) {
      const chatJids = Array.isArray(filters.chat_jid)
        ? filters.chat_jid
        : [filters.chat_jid];
      must.push({
        key: 'chat_jid',
        match: { any: chatJids },
      });
    }

    if (filters?.sender) {
      const senders = Array.isArray(filters.sender)
        ? filters.sender
        : [filters.sender];
      must.push({
        key: 'sender',
        match: { any: senders },
      });
    }

    if (filters?.group_name) {
      const groups = Array.isArray(filters.group_name)
        ? filters.group_name
        : [filters.group_name];
      must.push({
        key: 'group_name',
        match: { any: groups },
      });
    }

    if (filters?.startDate) {
      must.push({
        key: 'timestamp',
        range: { gte: filters.startDate },
      });
    }

    if (filters?.endDate) {
      must.push({
        key: 'timestamp',
        range: { lte: filters.endDate },
      });
    }

    const searchParams: any = {
      vector: queryVector,
      limit,
    };

    if (must.length > 0) {
      searchParams.filter = { must };
    }

    if (scoreThreshold !== undefined) {
      searchParams.score_threshold = scoreThreshold;
    }

    const results = await this.getClient().search(this.collectionName, searchParams);

    return results.map((result) => ({
      id: result.id.toString(),
      score: result.score,
      payload: result.payload,
    }));
  }

  async getCollectionInfo(): Promise<any> {
    await this.initializeCollection();
    return await this.getClient().getCollection(this.collectionName);
  }

  async deleteCollection(): Promise<void> {
    await this.getClient().deleteCollection(this.collectionName);
    this.initialized = false;
    console.log(`Deleted Qdrant collection: ${this.collectionName}`);
  }
}

export const qdrantClient = new QdrantClientWrapper();
