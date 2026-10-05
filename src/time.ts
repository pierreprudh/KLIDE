// Shared time formatting.
//
// This module used to carry a note saying elapsed-time helpers were being
// written per surface — "four separate `relativeTime` copies at last count" —
// and that "the old copies can migrate as their callers are touched". They
// didn't: all four were still there, byte-identical, and the module that named
// them had one real importer. A comment is not a seam.
//
// New time formatters go here, and there are no copies left to migrate.

/** A span of elapsed time, coarse on purpose: "18s", "4m", "1h 20m". For how
 *  long a conversation or run lasted, where minutes are the interesting unit —
 *  per-message precision belongs in the message footer. */
export function formatSpan(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${hr}h ${rest}m` : `${hr}h`;
}

/** Elapsed time as "Xh YYm". Minutes are zero-padded so the field stays
 *  fixed-width when displayed alongside `formatSpan` in a columnar list.
 *  The hour component is always present ("0h 07m"), rounds to the nearest
 *  minute. */
export function formatHours(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  const hr = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return `${hr}h ${String(min).padStart(2, "0")}m`;
}

/** How long ago, coarse: "just now", "12m ago", "5h ago", "3d ago".
 *
 *  Takes `nowMs` so a caller can render a stable list, and so this is testable
 *  without freezing the clock. Anything older than a day stops counting hours —
 *  past that the exact figure stops being what the reader wants. */
export function relativeTime(ts: number, nowMs: number = Date.now()): string {
  const min = Math.floor((nowMs - ts) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/** How long ago, at finer resolution: adds seconds at the near end and months
 *  and years at the far end.
 *
 *  A second formatter rather than an option because the two answer different
 *  questions. `relativeTime` labels recent activity, where "just now" under a
 *  minute is what a reader wants; a Git history spans years, and "412d ago"
 *  is not a useful way to say "over a year". */
export function relativeTimeLong(ts: number, nowMs: number = Date.now()): string {
  const diff = Math.max(0, nowMs - ts);
  const s = Math.floor(diff / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/** A clock reading in the reader's locale: "11:29 AM" or "11:29". The locale
 *  and zone are injectable so a test can pin them; callers pass nothing. */
export function formatClock(ts: number, opts: { locale?: string; timeZone?: string } = {}): string {
  return new Date(ts).toLocaleTimeString(opts.locale, { hour: "numeric", minute: "2-digit", timeZone: opts.timeZone });
}

/** Calendar day in the given zone as an integer, so two stamps can be
 *  compared by day without a day being 24 hours (it isn't, twice a year). */
function dayIndex(ts: number, opts: { locale?: string; timeZone?: string }): number {
  const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: opts.timeZone }).format(new Date(ts));
  const [y, m, d] = parts.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

/** Where a turn sits in time, the way a reader picking a thread back up wants
 *  it: "Today 11:29 AM", "Yesterday 4:40 PM", a weekday inside the week
 *  ("Monday 4:40 PM"), then a date ("3 Oct 4:40 PM"), with the year only once
 *  it differs from this one. */
export function formatDayStamp(ts: number, nowMs: number = Date.now(), opts: { locale?: string; timeZone?: string } = {}): string {
  const clock = formatClock(ts, opts);
  const days = dayIndex(nowMs, opts) - dayIndex(ts, opts);
  if (days === 0) return `Today ${clock}`;
  if (days === 1) return `Yesterday ${clock}`;
  const date = new Date(ts);
  if (days > 1 && days < 7) {
    return `${date.toLocaleDateString(opts.locale, { weekday: "long", timeZone: opts.timeZone })} ${clock}`;
  }
  const sameYear = new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone: opts.timeZone }).format(date)
    === new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone: opts.timeZone }).format(new Date(nowMs));
  const day = date.toLocaleDateString(opts.locale, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }), timeZone: opts.timeZone });
  return `${day} ${clock}`;
}
