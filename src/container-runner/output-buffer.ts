/**
 * Append-only string buffer that caps total size and reports once it
 * starts dropping input. Keeps the large/truncation logic out of the
 * spawn callback so we can unit-test it without mocking child_process.
 */
export class TruncatingBuffer {
  private data = '';
  private truncated = false;

  constructor(private readonly maxSize: number) {}

  append(chunk: string): void {
    if (this.truncated) return;
    const remaining = this.maxSize - this.data.length;
    if (chunk.length > remaining) {
      this.data += chunk.slice(0, remaining);
      this.truncated = true;
    } else {
      this.data += chunk;
    }
  }

  get text(): string {
    return this.data;
  }

  get wasTruncated(): boolean {
    return this.truncated;
  }

  get length(): number {
    return this.data.length;
  }
}
