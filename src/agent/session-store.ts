export interface SessionStorePersistence {
  getSession: (groupFolder: string, providerId: string) => string | undefined;
  setSession: (
    groupFolder: string,
    sessionId: string,
    providerId: string,
  ) => void;
  deleteSession: (groupFolder: string, providerId: string) => void;
}

export interface AgentSessionStore {
  hydrate: (
    groupFolder: string,
    providerId: string,
    sessionId?: string,
  ) => void;
  get: (groupFolder: string, providerId: string) => string | undefined;
  set: (groupFolder: string, providerId: string, sessionId: string) => void;
  delete: (groupFolder: string, providerId: string) => void;
}

function getSessionKey(groupFolder: string, providerId: string): string {
  return JSON.stringify([groupFolder, providerId]);
}

export function createSessionStore(
  persistence: SessionStorePersistence,
): AgentSessionStore {
  const cache = new Map<string, string>();

  return {
    hydrate(groupFolder, providerId, sessionId) {
      const key = getSessionKey(groupFolder, providerId);
      if (sessionId) {
        cache.set(key, sessionId);
        return;
      }

      cache.delete(key);
    },

    get(groupFolder, providerId) {
      const key = getSessionKey(groupFolder, providerId);
      const cached = cache.get(key);
      if (cached) {
        return cached;
      }

      const persisted = persistence.getSession(groupFolder, providerId);
      if (persisted) {
        cache.set(key, persisted);
      }

      return persisted;
    },

    set(groupFolder, providerId, sessionId) {
      cache.set(getSessionKey(groupFolder, providerId), sessionId);
      persistence.setSession(groupFolder, sessionId, providerId);
    },

    delete(groupFolder, providerId) {
      cache.delete(getSessionKey(groupFolder, providerId));
      persistence.deleteSession(groupFolder, providerId);
    },
  };
}
