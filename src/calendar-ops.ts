import type { calendar_v3 } from 'googleapis';
import { logger } from './logger.js';
import {
  discoverCalendarAccounts,
  buildCalendarClient,
} from './calendar-fetcher.js';

export type RsvpResponse = 'accepted' | 'declined' | 'tentative';

export interface CalendarOpsProvider {
  rsvp(eventId: string, response: RsvpResponse): Promise<void>;
}

/**
 * Google Calendar RSVP provider using events.patch API.
 * Requires calendar.events scope (not just calendar.readonly).
 */
export class GoogleCalendarOpsProvider implements CalendarOpsProvider {
  constructor(
    private calendar: calendar_v3.Calendar,
    private userEmail: string,
    private accountLabel: string,
  ) {}

  async rsvp(eventId: string, response: RsvpResponse): Promise<void> {
    // Fetch the event to get current attendees
    const event = await this.calendar.events.get({
      calendarId: 'primary',
      eventId,
    });

    const attendees = event.data.attendees ?? [];
    const me = attendees.find(
      (a) => a.email?.toLowerCase() === this.userEmail.toLowerCase(),
    );

    if (me) {
      me.responseStatus = response;
    } else {
      // User is not in attendees list — add them
      attendees.push({
        email: this.userEmail,
        responseStatus: response,
      });
    }

    await this.calendar.events.patch({
      calendarId: 'primary',
      eventId,
      requestBody: { attendees },
    });

    logger.info(
      { eventId, response, account: this.accountLabel },
      'Calendar RSVP sent',
    );
  }
}

/**
 * Discover calendar accounts and build a CalendarOpsRouter with real providers.
 * Accounts that only have calendar.readonly scope will log a warning but still
 * be registered — the RSVP call will fail with a clear API error.
 */
export function buildCalendarOpsRouter(): CalendarOpsRouter {
  const router = new CalendarOpsRouter();
  const accounts = discoverCalendarAccounts();

  for (const account of accounts) {
    const client = buildCalendarClient(account);
    if (!client) continue;

    // We need the user's email for RSVP attendee matching.
    // The Gmail channel knows this, but calendar-fetcher doesn't.
    // Use the account label as a placeholder — the actual email is
    // resolved via Gmail channel's emailAddress getter in production.
    // For now, we'll detect it from the calendar API.
    client.calendarList
      .get({ calendarId: 'primary' })
      .then((res) => {
        const email = res.data.id || '';
        if (email) {
          const provider = new GoogleCalendarOpsProvider(
            client,
            email,
            account.label,
          );
          router.register(account.label, provider);
        }
      })
      .catch((err) => {
        logger.debug(
          { err, account: account.label },
          'Could not discover calendar email (non-fatal)',
        );
      });
  }

  return router;
}

export class CalendarOpsRouter {
  private providers = new Map<string, CalendarOpsProvider>();

  register(account: string, provider: CalendarOpsProvider): void {
    this.providers.set(account, provider);
    logger.info({ account }, 'Registered calendar ops provider');
  }

  async rsvp(
    account: string,
    eventId: string,
    response: RsvpResponse,
  ): Promise<void> {
    const provider = this.providers.get(account);
    if (!provider) {
      throw new Error(
        `No calendar provider registered for account: ${account}`,
      );
    }
    return provider.rsvp(eventId, response);
  }
}
