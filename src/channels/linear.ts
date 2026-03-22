import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR } from '../config.js';
import { getRouterState, setRouterState } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel } from '../types.js';

const AGENT_SESSIONS_KEY = 'linear_agent_sessions';

interface AgentActivity {
  type: 'thought' | 'action' | 'response' | 'error' | 'elicitation';
  content: string;
  action?: string; // only for 'action' type
  parameter?: string; // only for 'action' type
}

/**
 * Parse activity type from message text prefixes.
 * Supports: [thought] ..., [action:Name] ..., [action:Name|param] ..., [error] ..., [elicitation] ...
 * Default (no prefix): response
 */
function parseActivityType(text: string): AgentActivity {
  const thoughtMatch = text.match(/^\[thought\]\s*([\s\S]*)/);
  if (thoughtMatch) {
    return { type: 'thought', content: thoughtMatch[1].trim() };
  }

  const actionMatch = text.match(
    /^\[action:([^\]|]+)(?:\|([^\]]*))?\]\s*([\s\S]*)/,
  );
  if (actionMatch) {
    const actionName = actionMatch[1].trim();
    return {
      type: 'action',
      action: actionName,
      parameter: actionMatch[2]?.trim() || actionName,
      content: actionMatch[3].trim(),
    };
  }

  const errorMatch = text.match(/^\[error\]\s*([\s\S]*)/);
  if (errorMatch) {
    return { type: 'error', content: errorMatch[1].trim() };
  }

  const elicitMatch = text.match(/^\[elicitation\]\s*([\s\S]*)/);
  if (elicitMatch) {
    return { type: 'elicitation', content: elicitMatch[1].trim() };
  }

  return { type: 'response', content: text };
}

/** Path to the persisted OAuth token file */
const LINEAR_OAUTH_FILE = path.join(DATA_DIR, 'linear-oauth.json');

interface LinearOAuthData {
  access_token: string;
  bot_user_id: string;
}

/** Linear webhook event types we handle */
const SUPPORTED_TYPES = new Set(['Issue', 'Comment', 'AgentSessionEvent']);

/**
 * Verify the Linear webhook signature using HMAC-SHA256.
 * Linear sends the signature in the `Linear-Signature` header.
 */
export function verifyLinearSignature(
  secret: string,
  payload: string,
  signature: string,
): boolean {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature),
    );
  } catch {
    return false;
  }
}

/**
 * Build a group folder name from a Linear issue identifier.
 * Format: linear_{identifier-lowercased} (e.g., linear_eng-123)
 */
export function makeLinearFolder(identifier: string): string {
  const prefix = 'linear_';
  const sanitized = identifier
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 64 - prefix.length);
  return `${prefix}${sanitized}`;
}

interface FormattedEvent {
  text: string;
  metadata?: Record<string, string>;
}

/** Format a Linear webhook event into a human-readable message */
function formatEvent(
  type: string,
  action: string,
  data: any,
  actor: any,
): FormattedEvent | null {
  const actorName = actor?.name || actor?.id || 'someone';

  switch (type) {
    case 'Issue': {
      const identifier = data.identifier || data.id;
      const title = data.title || '';

      if (action === 'create') {
        const priority = data.priority != null ? ` (P${data.priority})` : '';
        return {
          text: `[Linear] Issue created: ${identifier} "${title}"${priority} by ${actorName}\n${data.url || ''}`,
        };
      }

      if (action === 'update') {
        const changes: string[] = [];

        if (data.assignee) {
          changes.push(`assigned to ${data.assignee.name || data.assignee.id}`);
        }
        if (data.state) {
          changes.push(`status → ${data.state.name || data.state.type}`);
        }
        if (data.priority != null && changes.length === 0) {
          changes.push(`priority → P${data.priority}`);
        }

        if (changes.length === 0) {
          // Generic update — still worth reporting
          changes.push('updated');
        }

        return {
          text: `[Linear] Issue ${identifier} "${title}": ${changes.join(', ')} by ${actorName}\n${data.url || ''}`,
        };
      }

      if (action === 'remove') {
        return {
          text: `[Linear] Issue ${identifier} "${title}" removed by ${actorName}`,
        };
      }

      return null;
    }

    case 'Comment': {
      const issueData = data.issue;
      if (!issueData) return null;

      const identifier = issueData.identifier || issueData.id;
      const body =
        (data.body || '').length > 200
          ? data.body.slice(0, 200) + '...'
          : data.body || '';

      if (action === 'create') {
        return {
          text: `[Linear] Comment on ${identifier} by ${actorName}:\n${body}\n${data.url || ''}`,
          metadata: {
            linear_comment_id: data.id,
            linear_issue_id: issueData.id,
            linear_issue_identifier: identifier,
          },
        };
      }

      return null;
    }

    case 'AgentSessionEvent': {
      const session = data.agentSession;
      if (!session) return null;
      const issue = session.issue;
      if (!issue) return null;
      const identifier = issue.identifier || issue.id;
      const title = issue.title || '';
      const url = issue.url || '';

      if (action === 'prompted') {
        // User replied within the agent session
        const userMessage =
          data.agentActivity?.body || data.promptContext || '';
        if (!userMessage) return null;
        return {
          text: `[Linear] Reply in agent session for ${identifier} by ${actorName}:\n${userMessage}`,
          metadata: {
            linear_agent_session_id: session.id || '',
            linear_issue_identifier: identifier,
          },
        };
      }

      // action === 'created' — initial delegation
      const promptContext = data.promptContext || '';
      const parts = [
        `[Linear] Issue ${identifier} "${title}" delegated to ${ASSISTANT_NAME}`,
      ];
      if (promptContext) parts.push(promptContext);
      if (url) parts.push(url);
      return {
        text: parts.join('\n'),
        metadata: {
          linear_agent_session_id: session.id || '',
          linear_issue_identifier: identifier,
        },
      };
    }

    default:
      return null;
  }
}

/**
 * Load persisted OAuth token from disk.
 */
export function loadLinearOAuth(): LinearOAuthData | null {
  try {
    if (!fs.existsSync(LINEAR_OAUTH_FILE)) return null;
    const raw = fs.readFileSync(LINEAR_OAUTH_FILE, 'utf-8');
    const data = JSON.parse(raw) as LinearOAuthData;
    if (data.access_token) return data;
    return null;
  } catch {
    return null;
  }
}

/**
 * Persist OAuth token to disk.
 */
export function saveLinearOAuth(data: LinearOAuthData): void {
  fs.mkdirSync(path.dirname(LINEAR_OAUTH_FILE), { recursive: true });
  fs.writeFileSync(LINEAR_OAUTH_FILE, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Exchange an authorization code for an OAuth access token.
 */
export async function exchangeLinearOAuthCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<{ access_token: string }> {
  const res = await fetch('https://api.linear.app/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Linear OAuth code exchange failed (${res.status}): ${body}`,
    );
  }
  return (await res.json()) as { access_token: string };
}

/**
 * Query the Linear API for the authenticated user's ID.
 */
export async function fetchLinearViewerId(token: string): Promise<string> {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: '{ viewer { id } }' }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Linear viewer query failed (${res.status}): ${body}`);
  }
  const result = (await res.json()) as any;
  const id = result.data?.viewer?.id;
  if (!id) throw new Error('Linear viewer query returned no ID');
  return id;
}

/**
 * Obtain an OAuth access token using Linear's client credentials grant.
 * Caches the token for reuse.
 */
export async function fetchLinearOAuthToken(
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const res = await fetch('https://api.linear.app/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'read,write',
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Linear OAuth token request failed (${res.status}): ${body}`,
    );
  }
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

export class LinearChannel implements Channel {
  name = 'linear';

  private connected = false;
  private opts: ChannelOpts;
  private webhookSecret: string;
  private clientId: string;
  private clientSecret: string;
  /** Cached OAuth access token */
  private accessToken: string | null = null;
  /** Linear user ID of the bot — issues assigned to this user skip the trigger */
  private botUserId: string;
  /** If set, only process events from these Linear team keys */
  private allowedTeams: Set<string> | null;
  /** Map from chatJid to active agent session ID — persisted to DB */
  private activeAgentSessions = new Map<string, string>();

  constructor(
    webhookSecret: string,
    clientId: string,
    clientSecret: string,
    botUserId: string,
    opts: ChannelOpts,
    allowedTeams: string[] = [],
  ) {
    this.webhookSecret = webhookSecret;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.botUserId = botUserId;
    this.opts = opts;
    this.allowedTeams = allowedTeams.length > 0 ? new Set(allowedTeams) : null;

    // Restore active agent sessions from DB
    this.loadAgentSessions();
  }

  /** Persist activeAgentSessions to the DB */
  private saveAgentSessions(): void {
    const obj = Object.fromEntries(this.activeAgentSessions);
    setRouterState(AGENT_SESSIONS_KEY, JSON.stringify(obj));
  }

  /** Load activeAgentSessions from the DB */
  private loadAgentSessions(): void {
    try {
      const raw = getRouterState(AGENT_SESSIONS_KEY);
      if (raw) {
        const obj = JSON.parse(raw) as Record<string, string>;
        for (const [jid, sessionId] of Object.entries(obj)) {
          this.activeAgentSessions.set(jid, sessionId);
        }
        if (this.activeAgentSessions.size > 0) {
          logger.info(
            { count: this.activeAgentSessions.size },
            'Linear: restored active agent sessions from DB',
          );
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to restore Linear agent sessions from DB');
    }
  }

  /** Set an agent session and persist */
  private setAgentSession(jid: string, sessionId: string): void {
    this.activeAgentSessions.set(jid, sessionId);
    this.saveAgentSessions();
  }

  /** Delete an agent session and persist */
  private deleteAgentSession(jid: string): void {
    this.activeAgentSessions.delete(jid);
    this.saveAgentSessions();
  }

  /**
   * Get a valid Linear API access token, fetching a new one if needed.
   */
  private async getAccessToken(): Promise<string | null> {
    if (!this.clientId || !this.clientSecret) return null;
    if (this.accessToken) return this.accessToken;
    try {
      this.accessToken = await fetchLinearOAuthToken(
        this.clientId,
        this.clientSecret,
      );
      return this.accessToken;
    } catch (err) {
      logger.error({ err }, 'Failed to obtain Linear OAuth token');
      return null;
    }
  }

  async connect(): Promise<void> {
    const app = this.opts.app;
    if (!app) {
      throw new Error(
        'Linear channel requires a shared Express app via opts.app',
      );
    }

    // Mount route-level body parser that captures raw body for signature verification
    const jsonParser = express.json({
      limit: '1mb',
      verify: (req: any, _res, buf) => {
        req.rawBody = buf.toString('utf-8');
      },
    });

    app.post('/linear/webhook', jsonParser, (req, res) => {
      const signature = req.headers['linear-signature'] as string;
      const deliveryId = req.headers['linear-delivery'] as string;
      const eventType = req.headers['linear-event'] as string;

      if (!signature) {
        res.status(400).json({ error: 'Missing Linear-Signature header' });
        return;
      }

      // Verify HMAC signature using raw body
      const rawBody = (req as any).rawBody || JSON.stringify(req.body);
      if (!verifyLinearSignature(this.webhookSecret, rawBody, signature)) {
        logger.warn({ deliveryId }, 'Linear webhook signature mismatch');
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }

      // Acknowledge immediately
      res.status(200).json({ ok: true });

      const payload = req.body;
      const type = payload.type || eventType;
      const action = payload.action;

      if (!type || !action) {
        logger.debug({ deliveryId }, 'Linear webhook missing type or action');
        return;
      }

      if (!SUPPORTED_TYPES.has(type)) {
        logger.debug({ type }, 'Skipping unsupported Linear event type');
        return;
      }

      // Process asynchronously
      this.processWebhook(type, action, payload, deliveryId).catch((err) =>
        logger.error({ err, type, action }, 'Error processing Linear webhook'),
      );
    });

    // OAuth callback handler for agent installation
    app.get('/linear/callback', (req, res) => {
      const code = req.query.code as string | undefined;
      if (!code) {
        res.status(400).send('Missing authorization code');
        return;
      }

      this.handleOAuthCallback(code)
        .then(() => {
          res
            .status(200)
            .send(
              '<!DOCTYPE html><html><body>' +
                '<h1>Seb has been installed successfully!</h1>' +
                '<p>You can close this tab.</p>' +
                '</body></html>',
            );
        })
        .catch((err) => {
          logger.error({ err }, 'Linear OAuth callback failed');
          res.status(500).send('OAuth callback failed: ' + String(err));
        });
    });

    // On startup, load persisted OAuth token if it exists
    const persisted = loadLinearOAuth();
    if (persisted) {
      this.accessToken = persisted.access_token;
      this.botUserId = persisted.bot_user_id;
      logger.info(
        { botUserId: this.botUserId },
        'Linear: loaded persisted OAuth token',
      );
    } else if (this.clientId && this.clientSecret) {
      // Fall back to client credentials if no persisted OAuth token
      this.getAccessToken().catch(() => {
        /* logged inside getAccessToken */
      });
    }

    this.connected = true;
    logger.info(
      'Linear routes mounted on /linear/webhook and /linear/callback',
    );
  }

  private async processWebhook(
    type: string,
    action: string,
    payload: any,
    deliveryId: string,
  ): Promise<void> {
    let data = payload.data;
    const actor = payload.actor;
    const timestamp = payload.createdAt || new Date().toISOString();

    // Handle AgentSessionEvent payload structure (different from Issue/Comment)
    if (type === 'AgentSessionEvent' && !data) {
      logger.info(
        { type, payloadKeys: Object.keys(payload) },
        'AgentSessionEvent payload structure',
      );
      const session = payload.agentSession || payload;
      if (session) {
        data = { agentSession: session };
      }
    }

    if (!data) {
      logger.warn({ type, action }, 'Linear webhook missing data field');
      return;
    }

    // Skip events triggered by the bot itself to avoid feedback loops
    if (this.botUserId && actor?.id === this.botUserId) {
      logger.debug(
        { type, action, actorId: actor.id },
        'Skipping Linear event from bot itself',
      );
      return;
    }

    // Determine the issue identifier and JID
    const issueData =
      type === 'AgentSessionEvent'
        ? data.agentSession?.issue
        : type === 'Comment'
          ? data.issue
          : data;
    const identifier = issueData?.identifier;
    if (!identifier) {
      logger.warn({ type, action }, 'Linear webhook missing issue identifier');
      return;
    }

    // Filter by allowed teams if configured
    const teamKey = issueData?.team?.key;
    if (this.allowedTeams && teamKey && !this.allowedTeams.has(teamKey)) {
      logger.debug(
        { teamKey, identifier },
        'Linear event from non-allowed team, skipping',
      );
      return;
    }

    const chatJid = `linear:${identifier}`;
    const senderName = actor?.name || actor?.id?.toString() || 'linear';

    // Store chat metadata
    this.opts.onChatMetadata(chatJid, timestamp, identifier, 'linear', false);

    // Auto-register group
    if (this.opts.registerGroup) {
      const registered = this.opts.registeredGroups();
      const assigneeId = issueData?.assignee?.id;
      const delegateId = issueData?.delegate?.id;
      const isAssignedToBot =
        !!this.botUserId &&
        (assigneeId === this.botUserId || delegateId === this.botUserId);
      // Delegation via AgentSessionEvent always means the bot should auto-respond
      const isDelegation = type === 'AgentSessionEvent';
      const skipTrigger = isDelegation || isAssignedToBot;

      if (!registered[chatJid]) {
        const folder = makeLinearFolder(identifier);
        const metadata: Record<string, string> = {
          type: 'issue',
          title: issueData?.title || '',
          identifier,
        };
        if (teamKey) metadata.team = teamKey;
        if (issueData?.assignee?.name)
          metadata.assignee = issueData.assignee.name;
        if (issueData?.state?.name) metadata.status = issueData.state.name;
        if (issueData?.priority != null)
          metadata.priority = String(issueData.priority);
        if (issueData?.url) metadata.url = issueData.url;
        if (issueData?.description)
          metadata.description = issueData.description;

        this.opts.registerGroup(chatJid, {
          name: identifier,
          folder,
          trigger: `@${ASSISTANT_NAME}`,
          added_at: timestamp,
          requiresTrigger: !skipTrigger,
          metadata,
        });
        logger.info(
          { chatJid, folder, isDelegation, isAssignedToBot },
          'Auto-registered Linear group',
        );
      } else if (
        isDelegation &&
        registered[chatJid].requiresTrigger !== false
      ) {
        // Delegation — ensure requiresTrigger is false
        this.opts.registerGroup(chatJid, {
          ...registered[chatJid],
          requiresTrigger: false,
          metadata: {
            ...registered[chatJid].metadata,
            ...(issueData?.assignee?.name
              ? { assignee: issueData.assignee.name }
              : {}),
          },
        });
        logger.info(
          { chatJid },
          'Updated Linear group to skip trigger (delegation)',
        );
      } else if (
        type === 'Issue' &&
        action === 'update' &&
        !this.activeAgentSessions.has(chatJid) &&
        registered[chatJid].requiresTrigger !== !isAssignedToBot
      ) {
        // Assignment changed — update requiresTrigger
        this.opts.registerGroup(chatJid, {
          ...registered[chatJid],
          requiresTrigger: !isAssignedToBot,
          metadata: {
            ...registered[chatJid].metadata,
            ...(issueData?.assignee?.name
              ? { assignee: issueData.assignee.name }
              : {}),
            ...(issueData?.state?.name ? { status: issueData.state.name } : {}),
          },
        });
        logger.info(
          { chatJid, isAssignedToBot },
          'Updated Linear group trigger setting',
        );
      }
    }

    // For any AgentSessionEvent, ensure the session is tracked
    if (type === 'AgentSessionEvent') {
      const sessionId = data.agentSession?.id;
      if (sessionId) {
        this.setAgentSession(chatJid, sessionId);
      }
    }

    // For new agent sessions, acknowledge immediately by emitting a "thought" activity
    if (type === 'AgentSessionEvent' && action === 'created') {
      const sessionId = data.agentSession?.id;
      if (sessionId) {
        this.acknowledgeAgentSession(sessionId).catch((err) =>
          logger.error(
            { err, sessionId },
            'Failed to acknowledge Linear agent session',
          ),
        );

        // Query repo suggestions and store in group metadata (fire-and-forget)
        const issueId = issueData?.id;
        if (issueId) {
          this.getAccessToken()
            .then((token) => {
              if (token) {
                return this.queryRepoSuggestions(issueId, sessionId, token);
              }
              return [];
            })
            .then((suggestions) => {
              if (suggestions.length > 0) {
                const repoList = suggestions
                  .map(
                    (s) =>
                      `- ${s.repositoryFullName} (confidence: ${(s.confidence * 100).toFixed(0)}%)`,
                  )
                  .join('\n');
                const group = this.opts.registeredGroups()[chatJid];
                if (group && this.opts.registerGroup) {
                  this.opts.registerGroup(chatJid, {
                    ...group,
                    metadata: {
                      ...group.metadata,
                      suggestedRepos: repoList,
                    },
                  });
                }
                logger.info(
                  { chatJid, suggestions },
                  'Linear repo suggestions fetched',
                );
              }
            })
            .catch((err) =>
              logger.warn({ err, chatJid }, 'Failed to fetch repo suggestions'),
            );
        }
      }
    }

    // Format the event
    const formatted = formatEvent(type, action, data, actor);
    if (!formatted) return;

    // For AgentSessionEvent, include promptContext for the container agent
    if (type === 'AgentSessionEvent') {
      const promptContext =
        payload.promptContext ||
        payload.agentSession?.promptContext ||
        data.agentSession?.promptContext;
      if (promptContext) {
        formatted.text += `\n\n<linear-context>\n${promptContext}\n</linear-context>`;
      }
    }

    // Deliver message
    this.opts.onMessage(chatJid, {
      id: deliveryId || crypto.randomUUID(),
      chat_jid: chatJid,
      sender: senderName,
      sender_name: senderName,
      content: formatted.text,
      timestamp,
      is_from_me: false,
      metadata: formatted.metadata,
    });

    logger.info(
      { type, action, chatJid, deliveryId },
      'Linear webhook event processed',
    );
  }

  /**
   * Acknowledge an agent session by emitting a "thought" activity.
   * Linear requires a response within 10 seconds of delegation.
   */
  private async acknowledgeAgentSession(sessionId: string): Promise<void> {
    const token = await this.getAccessToken();
    if (!token) {
      logger.warn(
        { sessionId },
        'Cannot acknowledge agent session — no access token',
      );
      return;
    }

    const mutation = `
      mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
        agentActivityCreate(input: $input) {
          success
        }
      }
    `;

    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: mutation,
        variables: {
          input: {
            agentSessionId: sessionId,
            content: {
              type: 'thought',
              body: 'Starting work on this issue...',
            },
          },
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      if (res.status === 401) this.accessToken = null;
      logger.error(
        { sessionId, status: res.status, body },
        'Linear API error acknowledging agent session',
      );
      return;
    }

    const result = (await res.json()) as any;
    if (result.errors) {
      logger.error(
        { sessionId, errors: result.errors },
        'Linear GraphQL errors acknowledging agent session',
      );
      return;
    }

    logger.info({ sessionId }, 'Linear agent session acknowledged');
  }

  /**
   * Post an activity to a Linear agent session.
   */
  private async postAgentActivity(
    sessionId: string,
    token: string,
    body: string,
    type:
      | 'thought'
      | 'action'
      | 'response'
      | 'error'
      | 'elicitation' = 'response',
    action?: string,
    parameter?: string,
  ): Promise<void> {
    const mutation = `
      mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
        agentActivityCreate(input: $input) {
          success
        }
      }
    `;

    // Build content based on type
    let content: Record<string, string>;
    if (type === 'action') {
      content = {
        type: 'action',
        action: action || body,
        parameter: parameter || action || body,
      };
      if (body && body !== action) content.result = body;
    } else {
      content = { type, body };
    }

    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: mutation,
        variables: {
          input: {
            agentSessionId: sessionId,
            content,
          },
        },
      }),
    });

    if (!res.ok) {
      const respBody = await res.text();
      if (res.status === 401) this.accessToken = null;
      throw new Error(
        `Linear API error posting agent activity (${res.status}): ${respBody}`,
      );
    }

    const result = (await res.json()) as any;
    if (result.errors) {
      throw new Error(
        `Linear GraphQL errors: ${JSON.stringify(result.errors)}`,
      );
    }
  }

  /**
   * Query Linear's issueRepositorySuggestions API for repo matches.
   */
  private async queryRepoSuggestions(
    issueId: string,
    sessionId: string,
    token: string,
  ): Promise<
    Array<{ repositoryFullName: string; hostname: string; confidence: number }>
  > {
    const query = `
      query($issueId: String!, $agentSessionId: String!) {
        issueRepositorySuggestions(
          issueId: $issueId
          agentSessionId: $agentSessionId
          candidateRepositories: [
            { hostname: "github.com", repositoryFullName: "cmraible/seb" }
          ]
        ) {
          suggestions {
            repositoryFullName
            hostname
            confidence
          }
        }
      }
    `;

    try {
      const res = await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          variables: { issueId, agentSessionId: sessionId },
        }),
      });

      if (!res.ok) return [];
      const result = (await res.json()) as any;
      return result?.data?.issueRepositorySuggestions?.suggestions || [];
    } catch (err) {
      logger.warn(
        { err, issueId, sessionId },
        'Failed to query repo suggestions',
      );
      return [];
    }
  }

  /**
   * Handle the OAuth callback: exchange code for token, fetch viewer ID,
   * persist both, and update the in-memory state.
   */
  async handleOAuthCallback(code: string): Promise<void> {
    const redirectUri = 'https://webhooks.seb-writes-code.dev/linear/callback';

    const { access_token } = await exchangeLinearOAuthCode(
      code,
      this.clientId,
      this.clientSecret,
      redirectUri,
    );

    const botUserId = await fetchLinearViewerId(access_token);

    // Persist to disk
    saveLinearOAuth({ access_token, bot_user_id: botUserId });

    // Update in-memory state
    this.accessToken = access_token;
    this.botUserId = botUserId;

    logger.info(
      { botUserId },
      'Linear OAuth callback: token exchanged and persisted',
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const match = jid.match(/^linear:(.+)$/);
    if (!match) {
      logger.error({ jid }, 'Invalid Linear JID format');
      return;
    }

    const token = await this.getAccessToken();
    if (!token) {
      logger.warn(
        { jid },
        'Linear OAuth credentials not configured — cannot post to Linear',
      );
      return;
    }

    const identifier = match[1];

    // Check for active agent session — respond via session activity instead of comment
    const sessionId = this.activeAgentSessions.get(jid);
    if (sessionId) {
      const activity = parseActivityType(text);
      try {
        await this.postAgentActivity(
          sessionId,
          token,
          activity.content,
          activity.type,
          activity.action,
          activity.parameter,
        );
        // Don't clear the session after a response — the agent session
        // remains active in Linear and the user may reply within it.
        // The session is only cleared on unrecoverable errors (below).
        logger.info(
          {
            jid,
            identifier,
            sessionId,
            activityType: activity.type,
            length: text.length,
          },
          'Linear agent session activity posted',
        );
        return;
      } catch (err) {
        logger.warn(
          { jid, identifier, sessionId, err, activityType: activity.type },
          'Failed to post agent session activity, retrying as response',
        );
        // If the activity type failed, retry as a simple response (most reliable type)
        if (activity.type !== 'response') {
          try {
            await this.postAgentActivity(
              sessionId,
              token,
              activity.content,
              'response',
            );
            logger.info(
              { jid, identifier, sessionId, length: text.length },
              'Linear agent session activity posted (fallback to response)',
            );
            return;
          } catch (retryErr) {
            logger.error(
              { jid, identifier, sessionId, err: retryErr },
              'Failed to post agent session activity even as response, falling back to comment',
            );
          }
        }
        // Only delete session if we truly can't post ANY activity
        this.deleteAgentSession(jid);
        // Fall through to comment
      }
    }

    // Fall back to regular comment
    try {
      const issueId = await this.resolveIssueId(identifier, token);
      if (!issueId) {
        logger.warn(
          { identifier },
          'Could not resolve Linear issue ID from identifier',
        );
        return;
      }

      const mutation = `
        mutation CommentCreate($input: CommentCreateInput!) {
          commentCreate(input: $input) {
            success
            comment { id }
          }
        }
      `;

      const res = await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: mutation,
          variables: {
            input: {
              issueId,
              body: text,
            },
          },
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        if (res.status === 401) this.accessToken = null;
        logger.error(
          { identifier, status: res.status, body },
          'Linear API error posting comment',
        );
        return;
      }

      const result = (await res.json()) as any;
      if (result.errors) {
        logger.error(
          { identifier, errors: result.errors },
          'Linear GraphQL errors posting comment',
        );
        return;
      }

      logger.info(
        { jid, identifier, length: text.length },
        'Linear comment posted',
      );
    } catch (err) {
      logger.error({ jid, identifier, err }, 'Failed to post Linear comment');
    }
  }

  /**
   * Resolve a Linear issue identifier (e.g., ENG-123) to its UUID.
   */
  private async resolveIssueId(
    identifier: string,
    token: string,
  ): Promise<string | null> {
    const query = `
      query IssueByIdentifier($id: String!) {
        issue(id: $id) {
          id
        }
      }
    `;

    try {
      const res = await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          variables: { id: identifier },
        }),
      });

      if (!res.ok) return null;
      const result = (await res.json()) as any;
      return result.data?.issue?.id ?? null;
    } catch {
      return null;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('linear:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    logger.info('Linear channel disconnected');
  }
}

registerChannel('linear', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'LINEAR_WEBHOOK_SECRET',
    'LINEAR_CLIENT_ID',
    'LINEAR_CLIENT_SECRET',
    'LINEAR_BOT_USER_ID',
    'LINEAR_ALLOWED_TEAMS',
  ]);
  const secret =
    process.env.LINEAR_WEBHOOK_SECRET || envVars.LINEAR_WEBHOOK_SECRET || '';
  const clientId =
    process.env.LINEAR_CLIENT_ID || envVars.LINEAR_CLIENT_ID || '';
  const clientSecret =
    process.env.LINEAR_CLIENT_SECRET || envVars.LINEAR_CLIENT_SECRET || '';
  const botUserId =
    process.env.LINEAR_BOT_USER_ID || envVars.LINEAR_BOT_USER_ID || '';
  const allowedTeamsRaw =
    process.env.LINEAR_ALLOWED_TEAMS || envVars.LINEAR_ALLOWED_TEAMS || '';
  const allowedTeams = allowedTeamsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!secret) {
    logger.warn('Linear: LINEAR_WEBHOOK_SECRET not set');
    return null;
  }

  if (!clientId || !clientSecret) {
    logger.warn(
      'Linear: LINEAR_CLIENT_ID/LINEAR_CLIENT_SECRET not set — webhook events will be received but replies will not be posted',
    );
  }

  if (botUserId) {
    logger.info(
      { botUserId },
      'Linear: bot user ID configured — assigned issues will skip trigger',
    );
  }

  if (allowedTeams.length > 0) {
    logger.info({ allowedTeams }, 'Linear: team allowlist active');
  }

  return new LinearChannel(
    secret,
    clientId,
    clientSecret,
    botUserId,
    opts,
    allowedTeams,
  );
});
