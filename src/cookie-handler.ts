import path from 'path';
import type { NewMessage } from './types.js';

export interface CookieHandlerDeps {
  writeFile: (filePath: string, content: string) => void;
  findInsuranceMountPath: (chatJid: string) => string | null;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

/**
 * L3 mechanistic cookie auto-handler.
 * Detects cookie JSON for backoffice systems in incoming messages,
 * converts to Playwright storageState format, saves to the right path,
 * and confirms to the user. No agent involvement needed.
 *
 * Returns true if a cookie was detected and saved, false otherwise.
 */
export function handleCookieMessage(
  deps: CookieHandlerDeps,
  chatJid: string,
  msg: NewMessage,
): boolean {
  if (msg.is_from_me || msg.is_bot_message) return false;
  const content = msg.content.trim();

  // Quick check: does this look like cookie JSON for a known domain?
  if (
    !content.includes('app.roeto.co.il') ||
    !content.includes('connect.roeto')
  )
    return false;

  // Try to parse as cookie JSON (browser plugin export format)
  try {
    const parsed = JSON.parse(content);
    const cookies = Array.isArray(parsed) ? parsed : [parsed];
    const roetoCookie = cookies.find(
      (c: Record<string, unknown>) =>
        c.name === 'connect.roeto' &&
        c.domain === 'app.roeto.co.il' &&
        typeof c.value === 'string',
    );

    if (!roetoCookie) return false;

    const insurancePath = deps.findInsuranceMountPath(chatJid);
    if (!insurancePath) return false;

    // Convert to Playwright storageState format
    const storageState = {
      cookies: [
        {
          name: roetoCookie.name,
          value: roetoCookie.value,
          domain: roetoCookie.domain,
          path: roetoCookie.path || '/',
          expires: roetoCookie.expirationDate || roetoCookie.expires || -1,
          httpOnly: roetoCookie.httpOnly ?? true,
          secure: roetoCookie.secure ?? true,
          sameSite: roetoCookie.sameSite || 'Lax',
        },
      ],
      origins: [],
    };

    const sessionFile = path.join(
      insurancePath,
      'tools',
      '.roeto-session.json',
    );
    deps.writeFile(sessionFile, JSON.stringify(storageState, null, 2));

    // Confirm to user mechanistically
    deps
      .sendMessage(chatJid, '✅ Roeto cookie saved automatically. Testing...')
      .then(() => {
        deps
          .sendMessage(
            chatJid,
            `✅ Cookie saved to ${path.basename(sessionFile)}. Next Roeto request will use the new session.`,
          )
          .catch(() => {});
      })
      .catch(() => {});

    return true;
  } catch {
    // Not valid JSON or not a cookie — ignore silently
    return false;
  }
}
