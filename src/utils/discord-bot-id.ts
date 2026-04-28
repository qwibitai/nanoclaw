export function botIdFromToken(token: string): string {
  const segment = token.split('.')[0];
  return Buffer.from(segment, 'base64').toString('utf8');
}
