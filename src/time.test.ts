import { describe, expect, it } from "vitest";
import {
  formatClock,
  formatDayStamp,
  formatHours,
  formatSpan,
  relativeTime,
  relativeTimeLong,
} from "./time";

// `nowMs` is injectable precisely so these don't have to freeze the clock.
const NOW = 1_700_000_000_000;
const ago = (ms: number) => NOW - ms;
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("relativeTime", () => {
  it("collapses anything under a minute to 'just now'", () => {
    expect(relativeTime(ago(0), NOW)).toBe("just now");
    expect(relativeTime(ago(59 * SEC), NOW)).toBe("just now");
  });

  it("counts minutes, then hours, then days", () => {
    expect(relativeTime(ago(MIN), NOW)).toBe("1m ago");
    expect(relativeTime(ago(59 * MIN), NOW)).toBe("59m ago");
    expect(relativeTime(ago(HOUR), NOW)).toBe("1h ago");
    expect(relativeTime(ago(23 * HOUR), NOW)).toBe("23h ago");
    expect(relativeTime(ago(DAY), NOW)).toBe("1d ago");
    expect(relativeTime(ago(400 * DAY), NOW)).toBe("400d ago");
  });

  it("does not go backwards for a future timestamp", () => {
    // Clock skew between a file's mtime and this machine shouldn't render
    // "-3m ago".
    expect(relativeTime(NOW + MIN, NOW)).toBe("just now");
  });
});

describe("relativeTimeLong", () => {
  it("adds seconds at the near end and months and years at the far end", () => {
    // Why it is a second formatter and not an option: a Git history spans years,
    // and "412d ago" is not a useful way to say "over a year".
    expect(relativeTimeLong(ago(2 * SEC), NOW)).toBe("just now");
    expect(relativeTimeLong(ago(30 * SEC), NOW)).toBe("30s ago");
    expect(relativeTimeLong(ago(5 * MIN), NOW)).toBe("5m ago");
    expect(relativeTimeLong(ago(5 * HOUR), NOW)).toBe("5h ago");
    expect(relativeTimeLong(ago(10 * DAY), NOW)).toBe("10d ago");
    expect(relativeTimeLong(ago(60 * DAY), NOW)).toBe("2mo ago");
    expect(relativeTimeLong(ago(400 * DAY), NOW)).toBe("1y ago");
  });

  it("clamps a future timestamp rather than reporting a negative age", () => {
    expect(relativeTimeLong(NOW + DAY, NOW)).toBe("just now");
  });
});

describe("formatSpan", () => {
  it("is coarse on purpose: seconds, minutes, then hours and minutes", () => {
    expect(formatSpan(18 * SEC)).toBe("18s");
    expect(formatSpan(4 * MIN)).toBe("4m");
    expect(formatSpan(HOUR)).toBe("1h");
    expect(formatSpan(HOUR + 20 * MIN)).toBe("1h 20m");
  });
});

describe("formatHours", () => {
  it('formats elapsed time as "Xh YYm" with zero-padded minutes', () => {
    expect(formatHours(2 * HOUR + 5 * MIN)).toBe("2h 05m");
    expect(formatHours(2 * HOUR)).toBe("2h 00m");
  });

  it("shows minutes alone when under an hour, still padded", () => {
    expect(formatHours(5 * MIN)).toBe("0h 05m");
  });

  it("rounds to the nearest minute", () => {
    expect(formatHours(HOUR + MIN + 30 * SEC)).toBe("1h 02m");
  });
});

describe("formatDayStamp", () => {
  // Pinned zone; the wording is English regardless of locale.
  const opts = { timeZone: "UTC" };
  // 2026-10-05 11:29 UTC, a Monday.
  const now = Date.UTC(2026, 9, 5, 11, 29);

  it("says Today and Yesterday by calendar day, not by 24-hour span", () => {
    expect(formatDayStamp(now, now, opts)).toBe("Today 11:29 AM");
    expect(formatDayStamp(Date.UTC(2026, 9, 5, 0, 5), now, opts)).toBe("Today 12:05 AM");
    expect(formatDayStamp(Date.UTC(2026, 9, 4, 16, 40), now, opts)).toBe("Yesterday 4:40 PM");
    expect(formatDayStamp(Date.UTC(2026, 9, 4, 23, 59), now, opts)).toBe("Yesterday 11:59 PM");
  });

  it("names the weekday inside the week, then the date", () => {
    expect(formatDayStamp(Date.UTC(2026, 9, 2, 9, 0), now, opts)).toBe("Friday 9:00 AM");
    expect(formatDayStamp(Date.UTC(2026, 8, 20, 9, 0), now, opts)).toBe("Sep 20 9:00 AM");
  });

  it("adds the year only once it differs", () => {
    expect(formatDayStamp(Date.UTC(2025, 11, 24, 18, 0), now, opts)).toBe("Dec 24, 2025 6:00 PM");
  });

  it("formats a bare clock reading", () => {
    expect(formatClock(now, opts)).toBe("11:29 AM");
  });
});
