import { LitElement, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { WsClient } from './api-client.ts';
import { renderApp } from './app-render.ts';
import type { TabId } from './navigation.ts';
import type {
  OverviewData, ChannelData, GroupData, TaskData,
  SessionData, SkillData, ConfigData, DebugData,
  LogEntry, MessageData,
} from './types.ts';

@customElement('nanoclaw-app')
export class NanoClawApp extends LitElement {
  // Disable shadow DOM so global CSS works
  createRenderRoot() { return this; }

  @state() tab: TabId = 'overview';
  @state() loading = false;
  @state() error: string | null = null;

  // Overview
  @state() overview: OverviewData | null = null;

  // Channels
  @state() channels: ChannelData[] = [];

  // Groups
  @state() groups: GroupData[] = [];
  @state() selectedGroupFolder: string | null = null;

  // Messages
  @state() messagesGroupJid: string = '';
  @state() messages: MessageData[] = [];
  @state() messagesHasMore = false;

  // Tasks
  @state() tasks: TaskData[] = [];

  // Sessions
  @state() sessions: SessionData[] = [];

  // Skills
  @state() skills: SkillData[] = [];
  @state() skillsFilter = '';
  @state() skillEditorName: string | null = null;
  @state() skillEditorContent = '';

  // Config
  @state() config: ConfigData | null = null;
  @state() claudeMdFolder: string = 'global';
  @state() claudeMdContent = '';
  @state() claudeMdDirty = false;

  // Logs
  @state() logs: LogEntry[] = [];
  @state() logsFilterText = '';
  @state() logsLevel = '';
  @state() logsAutoFollow = true;

  // Debug
  @state() debug: DebugData | null = null;

  // Chat
  @state() chatMessages: MessageData[] = [];
  @state() chatDraft = '';
  @state() chatStreaming = false;
  @state() chatStreamText = '';

  private ws = new WsClient();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private wsCleanup: (() => void) | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.ws.connect();
    this.wsCleanup = this.ws.on((msg) => this.handleWsMessage(msg));
    this.loadTab();
    // Refresh overview every 10s when on overview tab
    this.pollTimer = setInterval(() => {
      if (this.tab === 'overview') this.loadOverview();
    }, 10000);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.wsCleanup) this.wsCleanup();
  }

  private handleWsMessage(msg: { type: string; [key: string]: unknown }) {
    if (msg.type === 'chat.stream') {
      this.chatStreamText += msg.text as string;
    } else if (msg.type === 'chat.done') {
      this.chatStreaming = false;
      this.chatMessages = [
        ...this.chatMessages,
        {
          id: `resp-${Date.now()}`,
          chat_jid: 'web@chat',
          sender: 'assistant',
          sender_name: 'Assistant',
          content: msg.text as string,
          timestamp: new Date().toISOString(),
          is_from_me: true,
        },
      ];
      this.chatStreamText = '';
    } else if (msg.type === 'chat.ack') {
      // Message acknowledged
    } else if (msg.type === 'chat.error') {
      this.chatStreaming = false;
      this.chatStreamText = '';
      this.error = msg.error as string;
    }
  }

  switchTab(tab: TabId) {
    this.tab = tab;
    this.error = null;
    this.loadTab();
  }

  async loadTab() {
    this.loading = true;
    this.error = null;
    try {
      switch (this.tab) {
        case 'overview': await this.loadOverview(); break;
        case 'channels': await this.loadChannels(); break;
        case 'groups': await this.loadGroups(); break;
        case 'messages': await this.loadMessages(); break;
        case 'tasks': await this.loadTasks(); break;
        case 'sessions': await this.loadSessions(); break;
        case 'skills': await this.loadSkills(); break;
        case 'config': await this.loadConfig(); break;
        case 'logs': await this.loadLogs(); break;
        case 'debug': await this.loadDebug(); break;
        case 'chat': await this.loadChatHistory(); break;
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loading = false;
    }
  }

  private async fetchApi<T>(path: string, opts?: RequestInit): Promise<T> {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    return res.json();
  }

  async loadOverview() { this.overview = await this.fetchApi('/api/overview'); }
  async loadChannels() { this.channels = await this.fetchApi('/api/channels'); }
  async loadGroups() { this.groups = await this.fetchApi('/api/groups'); }
  async loadTasks() { this.tasks = await this.fetchApi('/api/tasks'); }
  async loadSessions() { this.sessions = await this.fetchApi('/api/sessions'); }
  async loadSkills() { this.skills = await this.fetchApi('/api/skills'); }
  async loadConfig() {
    this.config = await this.fetchApi('/api/config');
    await this.loadClaudeMd();
  }
  async loadLogs() {
    const params = new URLSearchParams();
    if (this.logsLevel) params.set('level', this.logsLevel);
    params.set('limit', '500');
    const data: { entries: LogEntry[] } = await this.fetchApi(`/api/logs?${params}`);
    this.logs = data.entries;
  }
  async loadDebug() { this.debug = await this.fetchApi('/api/debug'); }
  async loadChatHistory() {
    const data: { messages: MessageData[] } = await this.fetchApi('/api/chat/history');
    this.chatMessages = data.messages;
  }
  async loadMessages() {
    if (!this.messagesGroupJid) {
      this.messages = [];
      return;
    }
    const data: { messages: MessageData[]; hasMore: boolean } = await this.fetchApi(
      `/api/messages?group=${encodeURIComponent(this.messagesGroupJid)}&limit=50`,
    );
    this.messages = data.messages;
    this.messagesHasMore = data.hasMore;
  }
  async loadClaudeMd() {
    const endpoint = this.claudeMdFolder === 'global'
      ? '/api/config/global/claude-md'
      : `/api/config/groups/${encodeURIComponent(this.claudeMdFolder)}/claude-md`;
    const data: { content: string } = await this.fetchApi(endpoint);
    this.claudeMdContent = data.content;
    this.claudeMdDirty = false;
  }

  // Actions
  async saveClaudeMd() {
    const endpoint = this.claudeMdFolder === 'global'
      ? '/api/config/global/claude-md'
      : `/api/config/groups/${encodeURIComponent(this.claudeMdFolder)}/claude-md`;
    await this.fetchApi(endpoint, {
      method: 'PUT',
      body: JSON.stringify({ content: this.claudeMdContent }),
    });
    this.claudeMdDirty = false;
  }

  async toggleSkill(name: string) {
    await this.fetchApi(`/api/skills/${encodeURIComponent(name)}/toggle`, { method: 'POST' });
    await this.loadSkills();
  }

  async deleteSkill(name: string) {
    await this.fetchApi(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
    this.skillEditorName = null;
    await this.loadSkills();
  }

  async createSkill(name: string, content: string) {
    await this.fetchApi('/api/skills', {
      method: 'POST',
      body: JSON.stringify({ name, content }),
    });
    await this.loadSkills();
  }

  async updateSkill(name: string, content: string) {
    await this.fetchApi(`/api/skills/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    });
    await this.loadSkills();
  }

  async pauseTask(id: string) {
    await this.fetchApi(`/api/tasks/${id}/pause`, { method: 'POST' });
    await this.loadTasks();
  }

  async resumeTask(id: string) {
    await this.fetchApi(`/api/tasks/${id}/resume`, { method: 'POST' });
    await this.loadTasks();
  }

  async deleteTask(id: string) {
    await this.fetchApi(`/api/tasks/${id}`, { method: 'DELETE' });
    await this.loadTasks();
  }

  async deleteSession(folder: string) {
    await this.fetchApi(`/api/sessions/${encodeURIComponent(folder)}`, { method: 'DELETE' });
    await this.loadSessions();
  }

  sendChat() {
    if (!this.chatDraft.trim()) return;
    const text = this.chatDraft.trim();
    this.chatMessages = [
      ...this.chatMessages,
      {
        id: `user-${Date.now()}`,
        chat_jid: 'web@chat',
        sender: 'web-user',
        sender_name: 'You',
        content: text,
        timestamp: new Date().toISOString(),
        is_from_me: false,
      },
    ];
    this.chatDraft = '';
    this.chatStreaming = true;
    this.chatStreamText = '';
    this.ws.send({ type: 'chat.send', text });
  }

  updated(changed: Map<string, unknown>) {
    super.updated(changed);
    if (changed.has('chatMessages') || changed.has('chatStreamText') || changed.has('chatStreaming')) {
      const thread = this.querySelector('#chat-thread');
      if (thread) {
        thread.scrollTop = thread.scrollHeight;
      }
    }
  }

  render() {
    return renderApp(this);
  }
}
