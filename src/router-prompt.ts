/**
 * Router prompt builder — formats RouterRequest into a text prompt
 * for the Claude agent acting as a message router.
 */

import { RouterRequest } from './router-types.js';

/**
 * Build the routing prompt for the router agent.
 * The prompt instructs the agent to analyze the message and active cases,
 * then return a JSON routing decision.
 */
export function buildRouterPrompt(request: RouterRequest): string {
  const caseList = request.cases
    .map((c, i) => {
      const lastActivity = c.lastActivityAt
        ? formatTimeSince(new Date(c.lastActivityAt))
        : 'no activity';
      const lastMsg = c.lastMessage
        ? `"${c.lastMessage.slice(0, 120)}"`
        : 'none';
      return `${i + 1}. ID: ${c.id}
   Name: ${c.name} (${c.type}, ${c.status})
   Description: ${c.description}
   Last message: ${lastMsg} (${lastActivity})`;
    })
    .join('\n\n');

  const rejectionSection = request.rejectionHistory?.length
    ? `\nPreviously rejected routings (do NOT route to these again):\n${request.rejectionHistory
        .map((r) => `- Case "${r.caseName}" (${r.caseId}): ${r.reason}`)
        .join('\n')}\n`
    : '';

  return `You are a message router for a personal assistant system. Your ONLY job is to decide where an incoming message belongs.

Given a message and a list of active cases, decide:
1. Which case this message belongs to ("route_to_case")
2. If it's a simple question you can answer directly ("direct_answer") — greetings, factual questions, things clearly not related to any case
3. If no case matches well ("suggest_new") — the system will create a new case or handle it without case context

Active cases:

${caseList}
${rejectionSection}
Incoming message from ${request.senderName}:
"${request.messageText.slice(0, 1000)}"

Rules:
- Confidence threshold: 0.4+ to route to a case, below that use suggest_new
- Bias toward the most recently active case when ambiguous
- For direct_answer: only use for trivial messages (greetings, thanks, simple factual questions) that clearly don't relate to any case
- When using direct_answer, provide the answer text in the directAnswer field

You MUST call the \`route_decision\` tool exactly once with your decision. Do NOT output raw JSON — use the tool.
The request_id for this routing request is: "${request.requestId}"
The tool parameters are: request_id, decision, case_id, case_name, confidence, reason, direct_answer.`;
}

/**
 * Format a time difference as a human-readable string.
 */
function formatTimeSince(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
