/**
 * JWT authentication middleware for the portal API.
 */
import crypto from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';

import { readEnvFile } from '../../env.js';

const envSecrets = readEnvFile(['PORTAL_JWT_SECRET']);
const JWT_SECRET = process.env.PORTAL_JWT_SECRET || envSecrets.PORTAL_JWT_SECRET || 'nanoclaw-portal-dev-secret';
const TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface JwtPayload {
  sub: string; // user ID
  email: string;
  role: string;
  iat: number;
  exp: number;
}

function base64url(str: string): string {
  return Buffer.from(str).toString('base64url');
}

function base64urlDecode(str: string): string {
  return Buffer.from(str, 'base64url').toString('utf-8');
}

export function signToken(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
  const now = Date.now();
  const fullPayload: JwtPayload = {
    ...payload,
    iat: now,
    exp: now + TOKEN_EXPIRY_MS,
  };

  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(fullPayload));
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');

  return `${header}.${body}.${signature}`;
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [header, body, signature] = parts;
    const expectedSig = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(`${header}.${body}`)
      .digest('base64url');

    if (signature !== expectedSig) return null;

    const payload = JSON.parse(base64urlDecode(body)) as JwtPayload;
    if (payload.exp < Date.now()) return null;

    return payload;
  } catch {
    return null;
  }
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto
    .pbkdf2Sync(password, salt, 100000, 64, 'sha512')
    .toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, hash] = storedHash.split(':');
  if (!salt || !hash) return false;
  const computed = crypto
    .pbkdf2Sync(password, salt, 100000, 64, 'sha512')
    .toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(computed));
}

export interface AuthenticatedRequest extends IncomingMessage {
  user?: JwtPayload;
}

/**
 * Extract JWT payload from request. Returns null if not authenticated.
 */
export function authenticateRequest(req: IncomingMessage): JwtPayload | null {
  const authHeader = (req.headers as Record<string, string>)['authorization'];
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  return verifyToken(token);
}
