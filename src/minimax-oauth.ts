import { createHash, randomBytes } from 'node:crypto';
export type MiniMaxRegion = 'global' | 'cn';
const CLIENT_ID = '78257093-7e40-4613-99e0-527b14b39113';
const SCOPE = 'group_id profile model.completion';
const GRANT = 'urn:ietf:params:oauth:grant-type:user_code';
export const BASE: Record<MiniMaxRegion, string> = {
  global: 'https://api.minimax.io',
  cn: 'https://api.minimaxi.com',
};
export const ANTHROPIC_URL: Record<MiniMaxRegion, string> = {
  global: 'https://api.minimax.io/anthropic',
  cn: 'https://api.minimaxi.com/anthropic',
};

function b64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}
export function generatePkce() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));
  return { verifier, challenge, state };
}
function form(p: Record<string, string>): string {
  return Object.entries(p)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
    .join('&');
}

export interface MiniMaxToken {
  access: string;
  refresh: string;
  expires: number;
  resourceUrl?: string;
}

export async function requestDeviceCode(o: any) {
  const res = await fetch(BASE[o.region as MiniMaxRegion] + '/oauth/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({
      response_type: 'code',
      client_id: CLIENT_ID,
      scope: SCOPE,
      code_challenge: o.challenge,
      code_challenge_method: 'S256',
      state: o.state,
    }),
  });
  if (!res.ok)
    throw new Error('MiniMax OAuth code request failed: ' + (await res.text()));
  const d = (await res.json()) as any;
  if (!d.user_code)
    throw new Error(
      d.error || 'MiniMax OAuth: missing user_code or verification_uri',
    );
  if (d.state !== o.state) throw new Error('MiniMax OAuth: state mismatch');
  return d;
}

export async function pollForToken(o: any): Promise<any> {
  const res = await fetch(BASE[o.region as MiniMaxRegion] + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({
      grant_type: GRANT,
      client_id: CLIENT_ID,
      user_code: o.userCode,
      code_verifier: o.verifier,
    }),
  });
  const txt = await res.text();
  let d: any;
  try {
    d = JSON.parse(txt);
  } catch {
    d = null;
  }
  if (!res.ok)
    return { status: 'error', message: d?.base_resp?.status_msg || txt };
  if (!d)
    return {
      status: 'error',
      message: 'MiniMax OAuth: failed to parse token response',
    };
  if (d.status === 'error')
    return {
      status: 'error',
      message: 'MiniMax OAuth: server returned error status',
    };
  if (d.status !== 'success') return { status: 'pending' };
  if (!d.access_token || !d.refresh_token)
    return {
      status: 'error',
      message: 'MiniMax OAuth: incomplete token payload',
    };
  return {
    status: 'success',
    token: {
      access: d.access_token,
      refresh: d.refresh_token,
      expires: d.expired_in,
      resourceUrl: d.resource_url,
    },
  };
}

export async function refreshMiniMaxToken(o: any): Promise<MiniMaxToken> {
  const res = await fetch(BASE[o.region as MiniMaxRegion] + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: o.refreshToken,
    }),
  });
  if (!res.ok) throw new Error('MM refresh failed:' + (await res.text()));
  const d = (await res.json()) as any;
  if (!d.access_token || !d.refresh_token)
    throw new Error('MM refresh: incomplete payload');
  return {
    access: d.access_token,
    refresh: d.refresh_token,
    expires: d.expired_in,
    resourceUrl: d.resource_url,
  };
}

export async function loginWithMiniMax(o: any): Promise<MiniMaxToken> {
  const region = o.region ?? 'global';
  const { verifier, challenge, state } = generatePkce();
  const cr = await requestDeviceCode({ challenge, state, region });
  if (o.onDeviceCode) o.onDeviceCode(cr.user_code, cr.verification_uri);
  if (o.openUrl) {
    try {
      o.openUrl(cr.verification_uri);
    } catch {}
  }
  let iv = cr.interval ?? 2000;
  while (Date.now() < cr.expired_in) {
    await new Promise((r) => setTimeout(r, iv));
    const r = await pollForToken({ userCode: cr.user_code, verifier, region });
    if (r.status === 'success') return r.token;
    if (r.status === 'error') throw new Error('MiniMax OAuth: ' + r.message);
    iv = Math.min(iv * 1.5, 10000);
  }
  throw new Error('MiniMax OAuth timed out');
}
