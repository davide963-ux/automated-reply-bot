export interface ActiveWindow {
  start: string; // "HH:MM" in the account timezone
  end: string; // "HH:MM"; end <= start means the window crosses midnight
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Minutes since local midnight for `date` in IANA timezone `tz`. */
export function localMinutes(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

/** Local calendar date (YYYY-MM-DD) in `tz`. */
export function localDate(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** No windows configured = always active. */
export function isWithinActiveHours(date: Date, windows: ActiveWindow[], tz: string): boolean {
  if (windows.length === 0) return true;
  const now = localMinutes(date, tz);
  return windows.some((w) => {
    const s = toMinutes(w.start);
    const e = toMinutes(w.end);
    return s < e ? now >= s && now < e : now >= s || now < e;
  });
}

/** Earliest time >= `from` that is inside an active window (5-minute resolution, max 48h ahead). */
export function nextActiveTime(from: Date, windows: ActiveWindow[], tz: string): Date {
  if (isWithinActiveHours(from, windows, tz)) return from;
  const step = 5 * 60_000;
  for (let t = from.getTime() + step; t <= from.getTime() + 48 * 3_600_000; t += step) {
    if (isWithinActiveHours(new Date(t), windows, tz)) return new Date(t);
  }
  return from;
}

/** Total active minutes per day (24h when no windows). */
export function activeMinutesPerDay(windows: ActiveWindow[]): number {
  if (windows.length === 0) return 24 * 60;
  let total = 0;
  for (const w of windows) {
    const s = toMinutes(w.start);
    const e = toMinutes(w.end);
    total += s < e ? e - s : 24 * 60 - s + e;
  }
  return Math.min(total, 24 * 60);
}
