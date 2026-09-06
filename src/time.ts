/**
 * Timezone helpers built on Intl (Node ships the full IANA database).
 *
 * Sol finding #1/#5: never let a wall-clock value be interpreted in the host
 * timezone. Everything that is not an absolute instant is resolved against an
 * explicitly configured IANA zone.
 */

const PART_CACHE = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = PART_CACHE.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    PART_CACHE.set(timeZone, f);
  }
  return f;
}

export function assertValidTimeZone(timeZone: string): void {
  try {
    formatter(timeZone).format(new Date());
  } catch {
    throw new Error(`invalid IANA timezone: ${timeZone}`);
  }
}

/** Wall-clock fields of an instant, as seen in `timeZone`. */
export function wallPartsOf(instant: Date, timeZone: string) {
  const parts = formatter(timeZone).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

function asUtcMillis(w: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}): number {
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
}

/**
 * Resolve a wall-clock time in `timeZone` to an absolute instant.
 *
 * DST policy (Sol finding #5), stated explicitly because both cases are silent
 * corruption otherwise:
 *   - spring gap (wall time does not exist): shift forward to the first valid
 *     instant after the gap.
 *   - autumn fold (wall time happens twice): take the FIRST (earlier) instant.
 */
export function wallTimeToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const target = asUtcMillis({ year, month, day, hour, minute, second });

  // Two-pass offset resolution; correct for every real-world zone offset.
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const seen = asUtcMillis(wallPartsOf(new Date(guess), timeZone));
    guess = guess + (target - seen);
  }

  const roundTrip = asUtcMillis(wallPartsOf(new Date(guess), timeZone));
  if (roundTrip === target) {
    // Fold: one or more earlier instants may render the same wall time.
    // Scan backwards in 15-min steps (folds up to ~3h, incl. 30-min zones)
    // and take the EARLIEST matching instant.
    let earliest = guess;
    for (let step = 900_000; step <= 3 * 3600_000; step += 900_000) {
      const probe = guess - step;
      if (asUtcMillis(wallPartsOf(new Date(probe), timeZone)) === target) {
        earliest = probe;
      } else if (probe < earliest) {
      }
    }
    return new Date(earliest);
  }

  // Gap: requested wall time does not exist. Return the FIRST valid instant
  // whose wall time is at or after the request (shift-forward policy).
  // wallParts(t) is monotone non-decreasing across a gap, so binary search works.
  let lo = guess - 12 * 3600_000;
  let hi = guess + 12 * 3600_000;
  for (let i = 0; i < 40; i++) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (asUtcMillis(wallPartsOf(new Date(mid), timeZone)) >= target) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return new Date(hi);
}

/** Start of a calendar day (00:00 local) as an instant. */
export function startOfLocalDay(date: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return wallTimeToInstant(y, m, d, 0, 0, 0, timeZone);
}

/** `YYYY-MM-DD` for an instant, in the given zone. */
export function localDateString(instant: Date, timeZone: string): string {
  const w = wallPartsOf(instant, timeZone);
  return `${String(w.year).padStart(4, "0")}-${String(w.month).padStart(2, "0")}-${String(
    w.day,
  ).padStart(2, "0")}`;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return next.toISOString().slice(0, 10);
}

/** Strict YYYY-MM-DD → [year, month, day]; rejects nonexistent dates (round-trip check). */
export function splitDate(date: string): [number, number, number] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`expected YYYY-MM-DD, got "${date}"`);
  }
  const [y, m, d] = date.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1000 || y > 9999) {
    throw new Error(`invalid date "${date}"`);
  }
  const back = new Date(Date.UTC(y, m - 1, d));
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
    throw new Error(`invalid date "${date}" (does not exist)`);
  }
  return [y, m, d];
}

export function parseHhMm(value: string, label: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new Error(`${label} must be HH:MM, got "${value}"`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** ISO 8601 with the local offset of `timeZone` (e.g. 2026-09-07T11:00:00+02:00). */
export function toLocalIso(instant: Date, timeZone: string): string {
  const w = wallPartsOf(instant, timeZone);
  const wallAsUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const offMin = Math.round((wallAsUtc - instant.getTime()) / 60_000);
  const sign = offMin >= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  const pad = (n: number, w2 = 2) => String(n).padStart(w2, "0");
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(
    w.second,
  )}${sign}${pad(Math.trunc(abs / 60))}:${pad(abs % 60)}`;
}
