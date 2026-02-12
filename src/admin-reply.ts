/**
 * admin-reply.ts — AI-powered natural language reply interpreter.
 *
 * Classifies intent from admin/karyakarta replies to complaint notifications.
 * Uses Claude Sonnet via the Agent SDK query() with maxTurns: 1 (single inference).
 */
import { query } from '@anthropic-ai/claude-agent-sdk';

import { REPLY_INTERPRETER_MODEL } from './config.js';
import { logger } from './logger.js';

export type ReplyAction =
  | 'status_change'
  | 'add_note'
  | 'escalate_to_mla'
  | 'forward_to_officer'
  | 'approve'
  | 'reject'
  | 'unrecognized';

export interface ReplyResult {
  action: ReplyAction;
  newStatus?: string;
  rejectionReason?: string;
  note?: string;
  confidence: number;
}

/** Regex to extract complaint ID from notification text. */
const COMPLAINT_ID_RE = /ID:\s*([A-Z]{1,5}-\d{8}-\d{4})/;

/**
 * Extract complaint ID from quoted notification text.
 * Returns null if no ID pattern found.
 */
export function extractComplaintId(text: string): string | null {
  const match = text.match(COMPLAINT_ID_RE);
  return match ? match[1] : null;
}

/**
 * Parse AI response text into a ReplyResult.
 * Handles JSON wrapped in code fences or surrounded by text.
 */
export function parseAiResponse(text: string): ReplyResult {
  if (!text) return { action: 'unrecognized', confidence: 0 };

  // Strip markdown code fences
  let cleaned = text.replace(/```(?:json)?\s*\n?/g, '').trim();

  // Try to extract JSON object from text
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { action: 'unrecognized', confidence: 0 };

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.action || typeof parsed.action !== 'string') {
      return { action: 'unrecognized', confidence: 0 };
    }
    return {
      action: parsed.action,
      newStatus: parsed.newStatus,
      rejectionReason: parsed.rejectionReason,
      note: parsed.note,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
    };
  } catch {
    return { action: 'unrecognized', confidence: 0 };
  }
}

function buildPrompt(
  replyText: string,
  complaint: { id: string; status: string; category: string | null; description: string },
  role: 'admin' | 'karyakarta',
  validStatuses: string[],
): string {
  const complaintContext = [
    `Complaint ID: ${complaint.id}`,
    `Current status: ${complaint.status}`,
    `Category: ${complaint.category ?? 'N/A'}`,
    `Description: ${complaint.description}`,
  ].join('\n');

  const adminActions = `Available actions:
- "status_change" — change complaint status. Set "newStatus" to EXACTLY one of: ${validStatuses.join(', ')}
- "add_note" — add a remark/note without changing status
- "escalate_to_mla" — escalate to MLA for urgent attention
- "forward_to_officer" — forward to concerned officer (sets status to in_progress)
- "unrecognized" — message doesn't relate to complaint management

CRITICAL STATUS RULES — action keywords in the reply ALWAYS determine the status, even if the rest of the message describes ongoing work:
- Words like "solve", "resolved", "done", "fixed", "completed", "close", "बंद", "सोडवलं", "निकाल", "हल" → newStatus: "resolved"
- Words like "acknowledge", "noted" → newStatus: "acknowledged"
- Words like "working", "in progress", "started", "चालू" → newStatus: "in_progress"
- Words like "action taken", "कारवाई" → newStatus: "action_taken"
- Words like "hold", "pause", "wait", "थांबा" → newStatus: "on_hold"
- Words like "escalate" → newStatus: "escalated"
If the reply contains BOTH a resolution keyword AND progress details (e.g., "solve kara, tender issued, work will start"), the resolution keyword wins → "resolved".

Examples:
- "Resolve karo" / "Done" / "Fixed" / "Problem solve" → {"action":"status_change","newStatus":"resolved","note":"Resolved","confidence":0.95}
- "Ha problem solve kara, tender nighale, 1 mahinyat kam chalu hoyeel" → {"action":"status_change","newStatus":"resolved","note":"Tender issued, work will start within 1 month","confidence":0.92}
- "Mark this as resolved, road repaired" → {"action":"status_change","newStatus":"resolved","note":"Road repaired","confidence":0.95}
- "ये देख लो" / "Officer ko bhejo" → {"action":"forward_to_officer","note":"Forwarded to officer","confidence":0.85}
- "MLA sahab ko escalate karo" → {"action":"escalate_to_mla","note":"Escalated per admin request","confidence":0.9}
- "Note: spoke with water dept" → {"action":"add_note","note":"Spoke with water dept","confidence":0.9}
- "Good morning everyone" → {"action":"unrecognized","confidence":0.95}`;

  const karyakartaActions = `Available actions:
- "approve" — approve/validate the complaint
- "reject" — reject the complaint. Set "rejectionReason" to one of: duplicate, fraud, not_genuine, out_of_area, insufficient_info, other
- "add_note" — add a remark without changing status
- "unrecognized" — message doesn't relate to complaint validation

Examples:
- "Approved, genuine complaint" → {"action":"approve","note":"Genuine complaint","confidence":0.95}
- "मंजूर" / "हो बरोबर आहे" → {"action":"approve","confidence":0.9}
- "Reject, this is duplicate" → {"action":"reject","rejectionReason":"duplicate","note":"Duplicate complaint","confidence":0.9}
- "Fake complaint hai" → {"action":"reject","rejectionReason":"not_genuine","note":"Appears fake","confidence":0.85}
- "Will check tomorrow" → {"action":"add_note","note":"Will check tomorrow","confidence":0.8}`;

  const actions = role === 'admin' ? adminActions : karyakartaActions;

  return `You are classifying a ${role}'s reply to a complaint notification. Analyze the reply and return a JSON object with the intended action.

${complaintContext}

${actions}

Reply text: "${replyText}"

Respond with ONLY a JSON object. No explanation.`;
}

/**
 * Interpret a natural language reply using Claude Sonnet.
 *
 * @param replyText - The reply message text
 * @param complaint - The complaint being replied to
 * @param role - 'admin' or 'karyakarta' (constrains available actions)
 * @param validStatuses - Valid status values for status_change action
 */
export async function interpretReply(
  replyText: string,
  complaint: { id: string; status: string; category: string | null; description: string; phone: string },
  role: 'admin' | 'karyakarta',
  validStatuses: string[],
): Promise<ReplyResult> {
  const prompt = buildPrompt(replyText, complaint, role, validStatuses);

  try {
    let resultText = '';

    const q = query({
      prompt,
      options: {
        model: REPLY_INTERPRETER_MODEL,
        maxTurns: 1,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        disallowedTools: [
          'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
          'NotebookEdit', 'Task',
        ],
      },
    });

    for await (const message of q) {
      if (message.type === 'result' && message.subtype === 'success' && 'result' in message) {
        resultText = (message as { result: string }).result;
      }
    }

    const result = parseAiResponse(resultText);

    logger.info(
      {
        complaintId: complaint.id,
        role,
        action: result.action,
        newStatus: result.newStatus,
        note: result.note,
        confidence: result.confidence,
        replyLength: replyText.length,
      },
      'Reply interpreted',
    );

    return result;
  } catch (err) {
    logger.error({ err, complaintId: complaint.id, role }, 'Reply interpretation failed');
    return { action: 'unrecognized', confidence: 0 };
  }
}
