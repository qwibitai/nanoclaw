import { describe, it, expect } from 'vitest';
import {
  getEmailClassificationPrompt,
  getCalendarClassificationPrompt,
  EMAIL_SYSTEM_PROMPT,
  CALENDAR_SYSTEM_PROMPT,
  type EmailPayload,
  type CalendarPayload,
} from './classification-prompts.js';

describe('getEmailClassificationPrompt', () => {
  const sampleEmail: EmailPayload = {
    messageId: 'msg-001',
    threadId: 'thread-001',
    from: 'alice@example.com',
    to: ['bob@lab.edu'],
    cc: [],
    subject: 'Grant proposal feedback',
    snippet: 'Please review the attached draft by Friday.',
    date: '2026-03-21T09:00:00Z',
    labels: ['INBOX'],
    hasAttachments: false,
  };

  it('returns system and prompt strings', () => {
    const result = getEmailClassificationPrompt(sampleEmail);
    expect(result).toHaveProperty('system');
    expect(result).toHaveProperty('prompt');
    expect(typeof result.system).toBe('string');
    expect(typeof result.prompt).toBe('string');
  });

  it('system prompt contains JSON field names', () => {
    const result = getEmailClassificationPrompt(sampleEmail);
    expect(result.system).toContain('importance');
    expect(result.system).toContain('urgency');
    expect(result.system).toContain('topic');
    expect(result.system).toContain('summary');
    expect(result.system).toContain('suggestedRouting');
    expect(result.system).toContain('requiresClaude');
    expect(result.system).toContain('confidence');
  });

  it('prompt contains sender domain', () => {
    const result = getEmailClassificationPrompt(sampleEmail);
    expect(result.prompt).toContain('example.com');
  });

  it('prompt contains subject and snippet', () => {
    const result = getEmailClassificationPrompt(sampleEmail);
    expect(result.prompt).toContain('Grant proposal feedback');
    expect(result.prompt).toContain(
      'Please review the attached draft by Friday.',
    );
  });

  it('uses EMAIL_SYSTEM_PROMPT constant', () => {
    const result = getEmailClassificationPrompt(sampleEmail);
    expect(result.system).toBe(EMAIL_SYSTEM_PROMPT);
  });
});

describe('getCalendarClassificationPrompt', () => {
  const newEvent: CalendarPayload = {
    changeType: 'created',
    event: {
      title: 'Team standup',
      start: '2026-03-22T10:00:00Z',
      end: '2026-03-22T10:30:00Z',
      location: 'Zoom',
      calendar: 'Work',
      attendees: ['alice@lab.edu', 'bob@lab.edu'],
    },
  };

  const conflictingEvent: CalendarPayload = {
    changeType: 'created',
    event: {
      title: 'Grant review meeting',
      start: '2026-03-22T10:00:00Z',
      end: '2026-03-22T11:00:00Z',
      location: 'Room 301',
      calendar: 'Work',
      attendees: ['dean@university.edu'],
    },
    conflictsWith: {
      title: 'Team standup',
      start: '2026-03-22T10:00:00Z',
      end: '2026-03-22T10:30:00Z',
    },
  };

  it('returns system and prompt strings', () => {
    const result = getCalendarClassificationPrompt(newEvent);
    expect(result).toHaveProperty('system');
    expect(result).toHaveProperty('prompt');
    expect(typeof result.system).toBe('string');
    expect(typeof result.prompt).toBe('string');
  });

  it('system prompt contains JSON field names', () => {
    const result = getCalendarClassificationPrompt(newEvent);
    expect(result.system).toContain('importance');
    expect(result.system).toContain('urgency');
    expect(result.system).toContain('topic');
    expect(result.system).toContain('summary');
    expect(result.system).toContain('suggestedRouting');
    expect(result.system).toContain('requiresClaude');
    expect(result.system).toContain('confidence');
  });

  it('includes conflict details when present', () => {
    const result = getCalendarClassificationPrompt(conflictingEvent);
    expect(result.prompt).toContain('Team standup');
    expect(result.prompt).toContain('conflict');
  });

  it('handles new event without conflict', () => {
    const result = getCalendarClassificationPrompt(newEvent);
    expect(result.prompt).toContain('Team standup');
    expect(result.prompt).not.toContain('conflict');
  });

  it('prompt contains event title and change type', () => {
    const result = getCalendarClassificationPrompt(newEvent);
    expect(result.prompt).toContain('Team standup');
    expect(result.prompt).toContain('created');
  });

  it('uses CALENDAR_SYSTEM_PROMPT constant', () => {
    const result = getCalendarClassificationPrompt(newEvent);
    expect(result.system).toBe(CALENDAR_SYSTEM_PROMPT);
  });
});
