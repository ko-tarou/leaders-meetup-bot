/**
 * 006-0-1: Google Calendar mock adapter (GCalPort 互換)。
 *
 * 実 Calendar API を叩かず、イベント作成要求を記録し固定の eventId /
 * meetLink を返す。`src/services/gcal-event.ts` の createCalendarEvent /
 * createCalendarEventWithMeet 相当の境界をモックする想定。
 */
export type CalendarEventInput = {
  summary: string;
  start: string;
  end: string;
  [k: string]: unknown;
};

export type CalendarEventResult = {
  eventId: string;
  htmlLink: string;
  meetLink?: string;
};

export class MockGCalClient {
  public created: CalendarEventInput[] = [];
  private nextError: Error | null = null;
  private withMeet = true;

  reset(): void {
    this.created = [];
    this.nextError = null;
    this.withMeet = true;
  }

  failNext(err: Error): this {
    this.nextError = err;
    return this;
  }

  /** meetLink を返さない設定にする (Meet 生成失敗ケース再現用)。 */
  disableMeet(): this {
    this.withMeet = false;
    return this;
  }

  async createEvent(input: CalendarEventInput): Promise<CalendarEventResult> {
    if (this.nextError) {
      const e = this.nextError;
      this.nextError = null;
      throw e;
    }
    this.created.push(input);
    const n = this.created.length;
    return {
      eventId: `mock-event-${n}`,
      htmlLink: `https://calendar.google.com/event?eid=mock-${n}`,
      ...(this.withMeet ? { meetLink: `https://meet.google.com/mock-${n}` } : {}),
    };
  }
}

export function createMockGCalClient(): MockGCalClient {
  return new MockGCalClient();
}
