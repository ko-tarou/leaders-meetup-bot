/**
 * リマインド設定の解析ヘルパー。
 * 旧形式 `[3, 0]` と新形式 `[{daysBefore, message}]` の両方を扱う。
 */

export type ReminderConfig = {
  daysBefore: number;
  message: string | null;
};

export function parseReminderDaysBefore(raw: string): ReminderConfig[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item): ReminderConfig | null => {
        if (typeof item === "number") {
          return { daysBefore: item, message: null };
        }
        if (item && typeof item === "object") {
          const daysBefore = Number(item.daysBefore);
          if (isNaN(daysBefore)) return null;
          return {
            daysBefore,
            message: item.message ?? null,
          };
        }
        return null;
      })
      .filter((c): c is ReminderConfig => c !== null && !isNaN(c.daysBefore));
  } catch {
    return [];
  }
}
