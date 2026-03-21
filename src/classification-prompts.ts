/**
 * Classification prompts for Ollama (qwen3:8b) email and calendar event triage.
 * Returns JSON with: importance, urgency, topic, summary, suggestedRouting,
 * requiresClaude, confidence.
 */

export interface EmailPayload {
  messageId: string;
  threadId: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  snippet: string;
  date: string;
  labels: string[];
  hasAttachments: boolean;
}

export interface CalendarPayload {
  changeType: 'created' | 'updated' | 'deleted' | 'cancelled';
  event: {
    title: string;
    start: string;
    end: string;
    location?: string;
    calendar: string;
    attendees: string[];
  };
  conflictsWith?: {
    title: string;
    start: string;
    end: string;
  };
}

export interface ClassificationResult {
  /** 0-1 scale: 0 = not important, 1 = critical */
  importance: number;
  /** "low" | "medium" | "high" */
  urgency: string;
  /** Short category label, e.g. "grant", "scheduling", "admin" */
  topic: string;
  /** One-sentence summary */
  summary: string;
  /** Which NanoClaw group should handle this, e.g. "main", "LAB-claw" */
  suggestedRouting: string;
  /** Whether this item needs full Claude processing vs. simple notification */
  requiresClaude: boolean;
  /** 0-1 confidence in this classification */
  confidence: number;
}

const JSON_FIELDS_DESCRIPTION = `Respond ONLY with a JSON object (no markdown, no explanation) with these exact fields:
{
  "importance": <number 0-1>,
  "urgency": <"low"|"medium"|"high">,
  "topic": <string>,
  "summary": <string>,
  "suggestedRouting": <string>,
  "requiresClaude": <boolean>,
  "confidence": <number 0-1>
}`;

export const EMAIL_SYSTEM_PROMPT = `You are an email triage assistant. Classify incoming emails to help route and prioritize them.

${JSON_FIELDS_DESCRIPTION}

Field guidance:
- importance: 0=newsletters/spam, 0.3=FYI, 0.6=action needed, 0.9+=urgent/critical
- urgency: based on deadlines or time-sensitivity in the email
- topic: one of: grant, scheduling, admin, research, collaboration, personal, spam, finance, hr, support
- summary: one sentence describing what action (if any) is needed
- suggestedRouting: which assistant group should handle it (main, LAB-claw, SCIENCE-claw, etc.)
- requiresClaude: true if the email needs a thoughtful response or complex action; false for FYI/notification
- confidence: how confident you are in this classification`;

export const CALENDAR_SYSTEM_PROMPT = `You are a calendar event triage assistant. Classify calendar changes to help prioritize and route notifications.

${JSON_FIELDS_DESCRIPTION}

Field guidance:
- importance: 0=minor calendar noise, 0.5=regular meetings, 0.8=important events, 1.0=critical conflicts
- urgency: based on how soon the event occurs and whether action is needed
- topic: one of: meeting, deadline, personal, seminar, grant, conference, admin, appointment
- summary: one sentence describing the event and any notable issue (e.g. conflict)
- suggestedRouting: which assistant group should handle it (main, LAB-claw, etc.)
- requiresClaude: true if the change needs a decision or response (e.g. conflict resolution); false for simple notifications
- confidence: how confident you are in this classification`;

export function getEmailClassificationPrompt(email: EmailPayload): {
  system: string;
  prompt: string;
} {
  const senderDomain = email.from.includes('@')
    ? email.from.split('@')[1].replace('>', '').trim()
    : email.from;

  const toList = email.to.join(', ');
  const ccList = email.cc.length > 0 ? `CC: ${email.cc.join(', ')}\n` : '';
  const labelList = email.labels.join(', ');

  const prompt = `Classify this email:

From: ${email.from} (domain: ${senderDomain})
To: ${toList}
${ccList}Subject: ${email.subject}
Date: ${email.date}
Labels: ${labelList}
Has attachments: ${email.hasAttachments}

Snippet:
${email.snippet}`;

  return { system: EMAIL_SYSTEM_PROMPT, prompt };
}

export function getCalendarClassificationPrompt(
  calendarEvent: CalendarPayload,
): {
  system: string;
  prompt: string;
} {
  const { changeType, event, conflictsWith } = calendarEvent;

  const attendeeList =
    event.attendees.length > 0 ? event.attendees.join(', ') : 'none';
  const locationStr = event.location ? `Location: ${event.location}\n` : '';

  let conflictSection = '';
  if (conflictsWith) {
    conflictSection = `
CONFLICT DETECTED: This event conflicts with "${conflictsWith.title}" (${conflictsWith.start} – ${conflictsWith.end}).`;
  }

  const prompt = `Classify this calendar change:

Change type: ${changeType}
Event: ${event.title}
Calendar: ${event.calendar}
Start: ${event.start}
End: ${event.end}
${locationStr}Attendees: ${attendeeList}${conflictSection}`;

  return { system: CALENDAR_SYSTEM_PROMPT, prompt };
}
