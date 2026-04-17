import type { DraftInfo } from './draft-enrichment.js';

export interface EmailMeta {
  subject: string;
  from: string;
  to: string;
  date: string;
  cc?: string;
  body: string;
}

export interface GmailOps {
  archiveThread(account: string, threadId: string): Promise<void>;
  listRecentDrafts(account: string): Promise<DraftInfo[]>;
  updateDraft(account: string, draftId: string, newBody: string): Promise<void>;
  getMessageBody(account: string, messageId: string): Promise<string | null>;
  getMessageMeta(account: string, messageId: string): Promise<EmailMeta | null>;
  forwardThread(
    account: string,
    threadId: string,
    recipient: string,
  ): Promise<void>;
}

export interface GmailOpsProvider {
  archiveThread(threadId: string): Promise<void>;
  listRecentDrafts(): Promise<DraftInfo[]>;
  updateDraft(draftId: string, newBody: string): Promise<void>;
  getMessageBody(messageId: string): Promise<string | null>;
  getMessageMeta(messageId: string): Promise<EmailMeta | null>;
  forwardThread?(threadId: string, recipient: string): Promise<void>;
  emailAddress?: string;
}

export class GmailOpsRouter implements GmailOps {
  private channels = new Map<string, GmailOpsProvider>();
  private emailToAlias = new Map<string, string>();

  get accounts(): string[] {
    return [...this.channels.keys()];
  }

  register(alias: string, channel: GmailOpsProvider): void {
    this.channels.set(alias, channel);
    if (channel.emailAddress) {
      this.emailToAlias.set(channel.emailAddress, alias);
    }
  }

  private getChannel(account: string): GmailOpsProvider {
    // 1. Exact alias match
    const byAlias = this.channels.get(account);
    if (byAlias) return byAlias;

    // 2. Email→alias reverse lookup
    const alias = this.emailToAlias.get(account);
    if (alias) {
      const ch = this.channels.get(alias);
      if (ch) return ch;
    }

    throw new Error(`No Gmail channel registered for account: ${account}`);
  }

  async archiveThread(account: string, threadId: string): Promise<void> {
    return this.getChannel(account).archiveThread(threadId);
  }

  async listRecentDrafts(account: string): Promise<DraftInfo[]> {
    return this.getChannel(account).listRecentDrafts();
  }

  async updateDraft(
    account: string,
    draftId: string,
    newBody: string,
  ): Promise<void> {
    return this.getChannel(account).updateDraft(draftId, newBody);
  }

  async getMessageBody(
    account: string,
    messageId: string,
  ): Promise<string | null> {
    return this.getChannel(account).getMessageBody(messageId);
  }

  async getMessageMeta(
    account: string,
    messageId: string,
  ): Promise<EmailMeta | null> {
    return this.getChannel(account).getMessageMeta(messageId);
  }

  async forwardThread(
    account: string,
    threadId: string,
    recipient: string,
  ): Promise<void> {
    const ch = this.getChannel(account);
    if (!ch.forwardThread) {
      throw new Error(
        `Gmail channel for ${account} does not support forwarding`,
      );
    }
    return ch.forwardThread(threadId, recipient);
  }
}
