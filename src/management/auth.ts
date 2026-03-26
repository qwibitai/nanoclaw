import { timingSafeEqual } from 'crypto';

export function validateToken(token: string): boolean {
  const expected = process.env.MANAGEMENT_TOKEN || '';
  if (!expected || !token) return false;
  // Pad both buffers to the same length so timingSafeEqual doesn't
  // throw and the early-return length check can't leak token length.
  const len = Math.max(expected.length, token.length);
  const a = Buffer.alloc(len);
  const b = Buffer.alloc(len);
  a.write(expected);
  b.write(token);
  return timingSafeEqual(a, b);
}
