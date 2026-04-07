import type { NamedSession } from '../db.js';
import type { AgentSessionRepository } from '../repositories/agent-session-repository.js';

export const DEFAULT_AGENT_SESSION_LABEL = 'default';

export class AgentSessionService {
  constructor(
    private readonly repository: AgentSessionRepository,
    private readonly sessionState: Record<string, string>,
  ) {}

  getCurrentLabel(groupFolder: string, agentType: string): string {
    return (
      this.repository.getActiveLabel(groupFolder, agentType) ||
      DEFAULT_AGENT_SESSION_LABEL
    );
  }

  getLiveSession(groupFolder: string, agentType: string): string | undefined {
    return this.repository.getLiveSession(groupFolder, agentType);
  }

  recordSession(
    groupFolder: string,
    agentType: string,
    sessionId: string,
  ): void {
    this.sessionState[groupFolder] = sessionId;
    this.repository.setLiveSession(groupFolder, agentType, sessionId);
    this.repository.setNamedSession(
      groupFolder,
      agentType,
      this.getCurrentLabel(groupFolder, agentType),
      sessionId,
    );
  }

  clearLiveSession(groupFolder: string, agentType: string): void {
    delete this.sessionState[groupFolder];
    this.repository.deleteLiveSession(groupFolder, agentType);
  }

  listNamedSessions(groupFolder: string, agentType: string): NamedSession[] {
    return this.repository.listNamedSessions(groupFolder, agentType);
  }

  getNamedSession(
    groupFolder: string,
    agentType: string,
    label: string,
  ): NamedSession | undefined {
    return this.repository.getNamedSession(groupFolder, agentType, label);
  }

  startFreshSession(
    groupFolder: string,
    agentType: string,
    label: string,
  ): void {
    this.repository.setActiveLabel(groupFolder, agentType, label);
    this.clearLiveSession(groupFolder, agentType);
  }

  switchToNamedSession(
    groupFolder: string,
    agentType: string,
    label: string,
  ): NamedSession | undefined {
    const named = this.repository.getNamedSession(
      groupFolder,
      agentType,
      label,
    );
    if (!named) return undefined;
    this.repository.setActiveLabel(groupFolder, agentType, label);
    this.sessionState[groupFolder] = named.session_id;
    this.repository.setLiveSession(groupFolder, agentType, named.session_id);
    return named;
  }

  slugifyLabel(input: string): string {
    return input
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
  }

  createGeneratedLabel(): string {
    return `session-${new Date()
      .toISOString()
      .replace(/[:]/g, '-')
      .replace(/\.\d{3}Z$/, 'z')}`;
  }
}
