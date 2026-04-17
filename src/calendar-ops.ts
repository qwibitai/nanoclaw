import { logger } from './logger.js';

export type RsvpResponse = 'accepted' | 'declined' | 'tentative';

export interface CalendarOpsProvider {
  rsvp(eventId: string, response: RsvpResponse): Promise<void>;
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
