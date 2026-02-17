/**
 * In-memory poll vote accumulator.
 * Tracks poll metadata and per-voter selections from WebSocket events.
 * Votes are ephemeral and lost on process restart.
 */

export interface PollVoter {
  number: string;
  name: string;
  optionIndexes: number[];
  updatedAt: string;
}

export interface PollState {
  chatJid: string;
  authorNumber: string;
  createdTimestamp: number;
  question: string;
  options: string[];
  voters: Map<string, PollVoter>; // keyed by normalised phone number
  closed: boolean;
}

export interface PollResults {
  chatJid: string;
  authorNumber: string;
  createdTimestamp: number;
  question: string;
  options: Array<{ index: number; text: string; count: number; voters: string[] }>;
  totalVoters: number;
  closed: boolean;
}

/** Singleton poll store, keyed by "<chatJid>:<createdTimestamp>" */
const polls = new Map<string, PollState>();

function pollKey(chatJid: string, timestamp: number): string {
  return `${chatJid}:${timestamp}`;
}

function normalizePhone(phone: string): string {
  return phone.replace(/[^\d+]/g, '');
}

/** Register a poll when we create one or see a pollCreate event. */
export function registerPoll(
  chatJid: string,
  authorNumber: string,
  createdTimestamp: number,
  question: string,
  options: string[],
): void {
  const key = pollKey(chatJid, createdTimestamp);
  if (!polls.has(key)) {
    polls.set(key, {
      chatJid,
      authorNumber,
      createdTimestamp,
      question,
      options,
      voters: new Map(),
      closed: false,
    });
  }
}

/** Record a vote. Replaces the voter's previous selection (Signal behaviour). */
export function recordVote(
  chatJid: string,
  targetTimestamp: number,
  voterNumber: string,
  voterName: string,
  optionIndexes: number[],
): boolean {
  const key = pollKey(chatJid, targetTimestamp);
  const poll = polls.get(key);
  if (!poll) return false;

  poll.voters.set(normalizePhone(voterNumber), {
    number: voterNumber,
    name: voterName,
    optionIndexes,
    updatedAt: new Date().toISOString(),
  });
  return true;
}

/** Mark a poll as closed. */
export function closePollState(chatJid: string, timestamp: number): void {
  const key = pollKey(chatJid, timestamp);
  const poll = polls.get(key);
  if (poll) poll.closed = true;
}

/** Get aggregated results for a specific poll. */
export function getPollResults(chatJid: string, timestamp: number): PollResults | null {
  const key = pollKey(chatJid, timestamp);
  const poll = polls.get(key);
  if (!poll) return null;
  return aggregatePoll(poll);
}

/** Get all polls for a chat, optionally filtered to open only. */
export function getChatPolls(chatJid: string, openOnly = false): PollResults[] {
  const results: PollResults[] = [];
  for (const poll of polls.values()) {
    if (poll.chatJid !== chatJid) continue;
    if (openOnly && poll.closed) continue;
    results.push(aggregatePoll(poll));
  }
  return results.sort((a, b) => b.createdTimestamp - a.createdTimestamp);
}

function aggregatePoll(poll: PollState): PollResults {
  const optionResults = poll.options.map((text, index) => ({
    index,
    text,
    count: 0,
    voters: [] as string[],
  }));

  for (const voter of poll.voters.values()) {
    for (const idx of voter.optionIndexes) {
      if (idx >= 0 && idx < optionResults.length) {
        optionResults[idx].count++;
        optionResults[idx].voters.push(voter.name || voter.number);
      }
    }
  }

  return {
    chatJid: poll.chatJid,
    authorNumber: poll.authorNumber,
    createdTimestamp: poll.createdTimestamp,
    question: poll.question,
    options: optionResults,
    totalVoters: poll.voters.size,
    closed: poll.closed,
  };
}
