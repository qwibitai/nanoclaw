import type { DraftInfo } from './draft-enrichment.js';

export interface EmailMeta {
  subject: string;
  from: string;
  to: string;
  date: string;
  cc?: string;
  body: string;
}

export interface DraftReplyContext {
  body: string;
  incoming: {
    from: string;
    to: string;
    subject: string;
    date: string;
    cc?: string;
  };
}

export interface GmailOps {
  archiveThread(account: string, threadId: string): Promise<void>;
  listRecentDrafts(account: string): Promise<DraftInfo[]>;
  updateDraft(account: string, draftId: string, newBody: string): Promise<void>;
  getMessageBody(account: string, messageId: string): Promise<string | null>;
  getMessageMeta(account: string, messageId: string): Promise<EmailMeta | null>;
  getThreadInboxStatus(
    account: string,
    threadId: string,
  ): Promise<'in' | 'out' | 'missing'>;
  forwardThread(
    account: string,
    threadId: string,
    recipient: string,
  ): Promise<void>;
  getDraftReplyContext(
    account: string,
    draftId: string,
  ): Promise<DraftReplyContext | null>;
  sendDraft(account: string, draftId: string): Promise<void>;
}

export interface GmailOpsProvider {
  archiveThread(threadId: string): Promise<void>;
  listRecentDrafts(): Promise<DraftInfo[]>;
  updateDraft(draftId: string, newBody: string): Promise<void>;
  getMessageBody(messageId: string): Promise<string | null>;
  getMessageMeta(messageId: string): Promise<EmailMeta | null>;
  getThreadInboxStatus?(threadId: string): Promise<'in' | 'out' | 'missing'>;
  forwardThread?(threadId: string, recipient: string): Promise<void>;
  emailAddress?: string;
  getDraftReplyContext(draftId: string): Promise<DraftReplyContext | null>;
  sendDraft(draftId: string): Promise<void>;
}

export function deriveLocalPart(account: string): string | null {
  if (!account) return null;
  const at = account.indexOf('@');
  const local = at === -1 ? account : account.slice(0, at);
  return local ? local.toLowerCase() : null;
}

export class GmailOpsRouter implements GmailOps {
  private channels = new Map<string, GmailOpsProvider>();
  private emailToAlias = new Map<string, string>();
  private localPartToAlias = new Map<string, string>();

  get accounts(): string[] {
    return [...this.channels.keys()];
  }

  register(alias: string, channel: GmailOpsProvider): void {
    this.channels.set(alias, channel);
    if (channel.emailAddress) {
      const email = channel.emailAddress.toLowerCase();
      this.emailToAlias.set(email, alias);
      const localPart = deriveLocalPart(email);
      if (localPart && !this.localPartToAlias.has(localPart)) {
        // First-registered channel wins for a given local-part, to keep
        // resolution deterministic when multiple accounts share one.
        this.localPartToAlias.set(localPart, alias);
      }
    }
  }

  private getChannel(account: string): GmailOpsProvider {
    const key = account.toLowerCase();

    // 1. Exact alias match
    const byAlias = this.channels.get(account) ?? this.channels.get(key);
    if (byAlias) return byAlias;

    // 2. Email→alias reverse lookup
    const emailAlias = this.emailToAlias.get(key);
    if (emailAlias) {
      const ch = this.channels.get(emailAlias);
      if (ch) return ch;
    }

    // 3. Local-part lookup — SSE payloads sometimes send the email's
    // local-part (e.g. "topcoder1" from "topcoder1@gmail.com") instead
    // of the configured alias. Fall back to that before giving up.
    const localPart = deriveLocalPart(key);
    if (localPart) {
      const localAlias = this.localPartToAlias.get(localPart);
      if (localAlias) {
        const ch = this.channels.get(localAlias);
        if (ch) return ch;
      }
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

  async getThreadInboxStatus(
    account: string,
    threadId: string,
  ): Promise<'in' | 'out' | 'missing'> {
    const ch = this.getChannel(account);
    if (!ch.getThreadInboxStatus) {
      throw new Error(
        `Gmail channel for ${account} does not support getThreadInboxStatus`,
      );
    }
    return ch.getThreadInboxStatus(threadId);
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

  async getDraftReplyContext(
    account: string,
    draftId: string,
  ): Promise<DraftReplyContext | null> {
    return this.getChannel(account).getDraftReplyContext(draftId);
  }

  async sendDraft(account: string, draftId: string): Promise<void> {
    return this.getChannel(account).sendDraft(draftId);
  }
}
