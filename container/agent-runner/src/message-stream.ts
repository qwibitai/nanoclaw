export interface ImageAttachment {
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  data: string;
}

type ImageMediaType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/gif'
  | 'image/webp';
type ImageContentBlock = {
  type: 'image';
  source: { type: 'base64'; media_type: ImageMediaType; data: string };
};
type TextContentBlock = { type: 'text'; text: string };
export type UserContentBlock = ImageContentBlock | TextContentBlock;

export interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string | UserContentBlock[] };
  parent_tool_use_id: null;
  session_id: string;
}

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
export class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string, images?: ImageAttachment[]): void {
    const content: string | UserContentBlock[] = images?.length
      ? [
          ...images.map((img) => ({
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: img.mediaType,
              data: img.data,
            },
          })),
          { type: 'text' as const, text },
        ]
      : text;
    this.queue.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}
