/**
 * Classification prompts for NanoClaw Event Router.
 *
 * Provides system prompts and user prompt builders for Ollama-based
 * classification of email and calendar events.
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
    calendar?: string;
    attendees?: string[];
    description?: string;
  };
  conflictsWith?: {
    title: string;
    start: string;
    end: string;
  };
}

export interface PromptResult {
  system: string;
  prompt: string;
}

export const EMAIL_SYSTEM_PROMPT = `You are an email classification assistant. Analyze the email and return a JSON object with the following fields:
- importance: number 0.0-1.0 (how important this email is)
- urgency: number 0.0-1.0 (how time-sensitive this email is)
- topic: string (brief topic category, e.g. "grant", "meeting", "collaboration")
- summary: string (one sentence summary)
- suggestedRouting: "notify" | "autonomous" | "escalate" (suggested handling)
- requiresClaude: boolean (whether this needs LLM processing)
- confidence: number 0.0-1.0 (your confidence in this classification)

Respond with only the JSON object, no other text.`;

export const CALENDAR_SYSTEM_PROMPT = `You are a calendar event classification assistant. Analyze the calendar event and return a JSON object with the following fields:
- importance: number 0.0-1.0 (how important this event is)
- urgency: number 0.0-1.0 (how time-sensitive this event is)
- topic: string (brief topic category, e.g. "meeting", "deadline", "personal")
- summary: string (one sentence summary)
- suggestedRouting: "notify" | "autonomous" | "escalate" (suggested handling)
- requiresClaude: boolean (whether this needs LLM processing)
- confidence: number 0.0-1.0 (your confidence in this classification)

Respond with only the JSON object, no other text.`;

export function getEmailClassificationPrompt(
  payload: EmailPayload,
): PromptResult {
  const senderDomain = payload.from.includes('@')
    ? payload.from.split('@')[1]
    : payload.from;

  const lines = [
    `From: ${payload.from} (domain: ${senderDomain})`,
    `To: ${payload.to.join(', ')}`,
    payload.cc.length > 0 ? `CC: ${payload.cc.join(', ')}` : null,
    `Subject: ${payload.subject}`,
    `Date: ${payload.date}`,
    `Labels: ${payload.labels.join(', ')}`,
    `Has Attachments: ${payload.hasAttachments}`,
    ``,
    `Snippet:`,
    payload.snippet,
  ].filter((l): l is string => l !== null);

  return {
    system: EMAIL_SYSTEM_PROMPT,
    prompt: lines.join('\n'),
  };
}

export function getCalendarClassificationPrompt(
  payload: CalendarPayload,
): PromptResult {
  const lines: string[] = [
    `Change Type: ${payload.changeType}`,
    `Event: ${payload.event.title}`,
    `Start: ${payload.event.start}`,
    `End: ${payload.event.end}`,
  ];

  if (payload.event.location) {
    lines.push(`Location: ${payload.event.location}`);
  }
  if (payload.event.calendar) {
    lines.push(`Calendar: ${payload.event.calendar}`);
  }
  if (payload.event.attendees && payload.event.attendees.length > 0) {
    lines.push(`Attendees: ${payload.event.attendees.join(', ')}`);
  }
  if (payload.event.description) {
    lines.push(`Description: ${payload.event.description}`);
  }

  if (payload.conflictsWith) {
    lines.push('');
    lines.push(`Schedule conflict detected with existing event:`);
    lines.push(`  Title: ${payload.conflictsWith.title}`);
    lines.push(`  Start: ${payload.conflictsWith.start}`);
    lines.push(`  End: ${payload.conflictsWith.end}`);
  }

  return {
    system: CALENDAR_SYSTEM_PROMPT,
    prompt: lines.join('\n'),
  };
}
