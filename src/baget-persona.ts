/**
 * Persona prefix formatter for outbound Baget messages.
 *
 * The team-of-six prompt (setup/baget-template/CLAUDE.md.template)
 * instructs the model to start every reply with a role tag like
 * `cos: …`, `analyst: …`, `dev: …`. The Telegram channel adapter
 * runs this through `applyPersonaPrefix()` to translate the tag into
 * the founder's actual team-member name + role emoji:
 *
 *   model output:   `cos: Hey, what's on your mind?`
 *   chat surface:   `🧭 Louis: Hey, what's on your mind?`
 *
 * The translation is per-founder because each team has different names
 * (Founder A's CoS is "Louis", Founder B's is "Marc"). Names come from
 * the rendered CLAUDE.local.md at provision time and are passed in here
 * as a `BagetTeamMembers` map.
 *
 * Failure modes — the model occasionally drops the tag or writes one
 * we don't recognize. Both are handled gracefully:
 *
 *   - No tag detected     → message goes through unprefixed (matches the
 *                           CoS default voice; no-op cosmetically).
 *   - Unknown tag         → kept as a literal prefix so the founder sees
 *                           `unknown_tag: …` and we can debug. We don't
 *                           silently drop it — that hides bugs.
 *
 * Spec note: the original task referenced `apps/web/src/lib/channels/
 * agent/persona.ts` as a regex source. That file doesn't exist yet (the
 * in-app webhook handler used a different format). The regex shape here
 * is derived directly from the prompt template so the model's output
 * format and the formatter's parser can't drift.
 */
import type { BagetTeamMembers } from './baget-pairing.js';

/**
 * Recognized role tags. Six personas, one name per persona — matches
 * `@baget/shared::AgentRole` exactly (intern excluded). Ops is its own
 * member with its own name (was previously folded under design). The
 * earlier `strategist` tag is retired — long-range strategy / "should
 * we pivot" questions are CoS territory (cos voice already covers
 * strategic framing). Adding seven distinct personas to a Telegram-
 * sized reply diluted attribution.
 *
 * `dev` is the model's short tag for the `developer` member field.
 */
export type BagetRoleTag = 'cos' | 'dev' | 'marketing' | 'analyst' | 'design' | 'ops';

/** Emoji per role — matches the prompt's roster bullets one-for-one. */
const ROLE_EMOJI: Record<BagetRoleTag, string> = {
  cos: '🧭',
  dev: '💻',
  marketing: '📢',
  analyst: '📊',
  design: '🎨',
  ops: '⚙️',
};

/** Map role tag → BagetTeamMembers field. `dev` is remapped because
 *  the model uses the short tag while the type uses the verbose role
 *  name (`developer`). Ops is its own member, no longer aliased to
 *  design. */
const ROLE_TO_MEMBER: Record<BagetRoleTag, keyof BagetTeamMembers> = {
  cos: 'cos',
  dev: 'developer',
  marketing: 'marketing',
  analyst: 'analyst',
  design: 'design',
  ops: 'ops',
};

const KNOWN_ROLES = new Set<string>(Object.keys(ROLE_EMOJI));

/**
 * Match a leading `tag: ` on the first line. Anchored at start. The tag
 * itself is `[a-z]+` (lowercase only — the prompt uses lowercase) and we
 * deliberately allow a trailing space-or-newline before the body so
 * `cos:Body` (no space) works too.
 *
 * Capture groups:
 *   [1] — tag text (e.g. "cos")
 *   [2] — separator (": " or ":\n" or just ":")
 *   [3] — rest of the message (body)
 */
const TAG_PREFIX_RE = /^([a-z]+)(:[ \t]?\n?|:)([\s\S]*)$/;

export interface ParsedRoleTag {
  /** Recognized role tag, or null when the leading text wasn't a tag we know. */
  tag: BagetRoleTag | null;
  /** The literal tag text the model emitted (lowercased). Used for
   *  debugging unknown-tag fallback rendering. */
  rawTag: string | null;
  /** The message body with the tag prefix stripped. Equals the original
   *  message when tag is null. */
  body: string;
}

/**
 * Parse a leading role tag off a message. Pure, no I/O.
 *
 * Whitespace handling: a leading newline or carriage return before the
 * tag is tolerated so `\ncos: hi` parses identically to `cos: hi` —
 * some Claude responses include a stray newline at the very start.
 */
export function parseRoleTag(message: string): ParsedRoleTag {
  if (typeof message !== 'string' || message.length === 0) {
    return { tag: null, rawTag: null, body: message ?? '' };
  }
  // Strip any leading whitespace before the candidate tag.
  const trimmedLeading = message.replace(/^[\s]+/, '');
  const match = TAG_PREFIX_RE.exec(trimmedLeading);
  if (!match) {
    return { tag: null, rawTag: null, body: message };
  }
  const [, rawTag, , body] = match;
  const lowered = rawTag.toLowerCase();
  if (!KNOWN_ROLES.has(lowered)) {
    // Looks like a tag but isn't one we know — preserve the original
    // message so the founder sees `unknown: body…` and we get a signal
    // to either teach the model the tag or add it here.
    return { tag: null, rawTag: lowered, body: message };
  }
  return {
    tag: lowered as BagetRoleTag,
    rawTag: lowered,
    body: body.replace(/^[\s]+/, ''),
  };
}

/**
 * Render a model output as `<emoji> <Member>: <body>`.
 *
 * - On a recognized tag whose role is on the founder's team: prefix
 *   with the role's emoji + the founder's actual member name.
 * - On a recognized tag whose role is NOT on the team (apprenti
 *   founder, model hallucinated a `analyst:` reply when only CoS is
 *   hired): drop the tag and re-prefix as the CoS persona. This is
 *   the active-team-only safety net — the LLM's prompt has already
 *   been stripped of off-team roles, but we belt-and-braces here too
 *   so a stale prompt or a rogue model output can't surface a ghost
 *   name like "Clara" to the founder.
 * - On no tag detected: fall through to the CoS persona — matches the
 *   prompt's "Default greetings use cos:" rule.
 * - On a junk tag (looked tag-shaped but isn't one we know): pass
 *   through the raw message untouched. We leave it visible rather
 *   than silently re-prefixing so QA notices.
 */
export function applyPersonaPrefix(message: string, team: BagetTeamMembers): string {
  const parsed = parseRoleTag(message);

  if (parsed.tag !== null) {
    const memberName = team[ROLE_TO_MEMBER[parsed.tag]];
    if (typeof memberName === 'string' && memberName.trim().length > 0) {
      return `${ROLE_EMOJI[parsed.tag]} ${memberName}: ${parsed.body}`;
    }
    // Role's name is missing — the founder hasn't hired this role.
    // Re-prefix as CoS using the body sans the original tag.
    const cos = team.cos;
    if (typeof cos === 'string' && cos.trim().length > 0) {
      return `${ROLE_EMOJI.cos} ${cos}: ${parsed.body}`;
    }
    // CoS also missing (malformed payload — should never happen
    // because validateCreateBody requires it). Return the body without
    // a prefix rather than render `🧭 : body`.
    return parsed.body;
  }

  if (parsed.rawTag !== null) {
    // Unknown tag — pass through untouched (see jsdoc).
    return message;
  }

  // No tag — apply CoS as the default voice.
  const cos = team.cos;
  if (typeof cos !== 'string' || cos.trim().length === 0) {
    return message;
  }
  return `${ROLE_EMOJI.cos} ${cos}: ${message}`;
}
