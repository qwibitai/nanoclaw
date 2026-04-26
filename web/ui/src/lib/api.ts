/**
 * HTTP client to the Paraclaw web server.
 *
 * In dev: Vite proxies /api/* to localhost:4944.
 * In prod: server serves the built UI under /claw/, /api/* on the same origin.
 */

const API_BASE = "/api";

export type VaultScope = "vault:read" | "vault:write" | "vault:admin";

export interface VaultAttachment {
  vaultBaseUrl: string;
  scope: VaultScope;
  tokenLabel: string;
  attachedAt: string;
}

export interface AgentGroupView {
  id: string;
  name: string;
  folder: string;
  agent_provider: string | null;
  created_at: string;
  vault: VaultAttachment | null;
}

async function request<T>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  let body: BodyInit | undefined = init?.body as BodyInit | undefined;
  if (init?.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers, body });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const text = await res.text();
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) message = parsed.error;
      else if (text) message = text;
    } catch {
      // not JSON, use status
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function listGroups(): Promise<AgentGroupView[]> {
  const r = await request<{ groups: AgentGroupView[] }>("/groups");
  return r.groups;
}

export async function getGroup(folder: string): Promise<AgentGroupView> {
  const r = await request<{ group: AgentGroupView }>(
    `/groups/${encodeURIComponent(folder)}`,
  );
  return r.group;
}

export async function attachVault(
  folder: string,
  input: {
    scope: VaultScope;
    vaultBaseUrl?: string;
    tokenLabel?: string;
    token?: string;
    mcpName?: string;
  },
): Promise<{ group: AgentGroupView; mintedToken: boolean }> {
  return request<{ group: AgentGroupView; mintedToken: boolean }>(
    `/groups/${encodeURIComponent(folder)}/attach-vault`,
    { method: "POST", json: input },
  );
}

export async function detachVault(folder: string, mcpName?: string): Promise<AgentGroupView> {
  const r = await request<{ group: AgentGroupView }>(
    `/groups/${encodeURIComponent(folder)}/detach-vault`,
    { method: "POST", json: { mcpName } },
  );
  return r.group;
}

export interface FolderAvailability {
  slug: string;
  valid: boolean;
  available: boolean;
  reason?: string;
}

export async function checkFolderAvailability(slug: string): Promise<FolderAvailability> {
  return request<FolderAvailability>(
    `/folder-availability/${encodeURIComponent(slug)}`,
  );
}

export async function fetchFolderSuggestion(name: string): Promise<string> {
  const r = await request<{ name: string; slug: string }>(
    `/folder-suggestion?name=${encodeURIComponent(name)}`,
  );
  return r.slug;
}

export interface CreateGroupInput {
  name: string;
  folder: string;
  instructions?: string;
  vault?: {
    scope: VaultScope;
    vaultBaseUrl?: string;
    tokenLabel?: string;
    token?: string;
    mcpName?: string;
  };
}

export async function createGroup(input: CreateGroupInput): Promise<{
  group: AgentGroupView;
  mintedVaultToken: boolean;
}> {
  return request<{ group: AgentGroupView; mintedVaultToken: boolean }>(
    `/groups`,
    { method: "POST", json: input },
  );
}
