import {
  deleteAgentSession,
  getActiveAgentSessionLabel,
  getAgentSession,
  getNamedAgentSession,
  getNamedAgentSessions,
  setActiveAgentSessionLabel,
  setAgentSession,
  setNamedAgentSession,
  type NamedSession,
} from '../db.js';

export interface AgentSessionRepository {
  getLiveSession(groupFolder: string, agentType: string): string | undefined;
  setLiveSession(
    groupFolder: string,
    agentType: string,
    sessionId: string,
  ): void;
  deleteLiveSession(groupFolder: string, agentType: string): void;
  getNamedSession(
    groupFolder: string,
    agentType: string,
    label: string,
  ): NamedSession | undefined;
  listNamedSessions(groupFolder: string, agentType: string): NamedSession[];
  setNamedSession(
    groupFolder: string,
    agentType: string,
    label: string,
    sessionId: string,
  ): void;
  getActiveLabel(groupFolder: string, agentType: string): string | undefined;
  setActiveLabel(groupFolder: string, agentType: string, label: string): void;
}

export const dbAgentSessionRepository: AgentSessionRepository = {
  getLiveSession: getAgentSession,
  setLiveSession: setAgentSession,
  deleteLiveSession: deleteAgentSession,
  getNamedSession: getNamedAgentSession,
  listNamedSessions: getNamedAgentSessions,
  setNamedSession: setNamedAgentSession,
  getActiveLabel: getActiveAgentSessionLabel,
  setActiveLabel: setActiveAgentSessionLabel,
};
