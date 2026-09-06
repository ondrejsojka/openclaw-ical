/**
 * ICS parsing + recurrence expansion built on ical.js only (DESIGN.md: one
 * library, one timezone model, no custom parser).
 *
 * Verified against the live ical.js 2.2 behavior (probes, 2026-09-06) and
 * amended after the code-level adversarial review (same day, round 2):
 *
 *  - RecurExpansion handles RRULE/EXDATE, but does NOT apply RECURRENCE-ID
 *    overrides: the original and the moved occurrence both appear in the raw
 *    iteration. Overrides are therefore processed in a SEPARATE pass by their
 *    moved interval, and THEIR recurrence-ids suppressed in the master pass.
 *    (Fixes: moved-in-from-outside-window invisibility, early overshoot break.)
 *  - Override metadata (STATUS/TRANSP) is read from the exception component,
 *    with the master as fallback — a CANCELLED override cancels, an OPAQUE
 *    override on a TRANSPARENT master blocks (and vice versa).
 *  - RANGE=THISANDFUTURE exceptions are honored via findRangeException: the
 *    original is suppressed. The full range-modified restatement (new RRULE) is
 *    NOT implemented — the series is marked incomplete instead of lying.
 *  - Endpoints are converted INDEPENDENTLY: start to instant and end to
 *    instant, never start + fixedSeconds (no DST collapse, no phantom hour).
 *    Nominal recurrence durations use ICAL addDuration on the wall time.
 *  - Unregistered TZID leaves Time.zone = localTimezone and toUnixTime()
 *    silently treats wall time as UTC. Unresolvable TZIDs are warned about and
 *    interpreted in the configured zone — never silently UTC, never silently
 *    floating.
 *  - VTIMEZONE registration in ical.js is global. expandFeed() registers this
 *    feed's zones, converts everything eagerly, and ALWAYS unregisters them
 *    (finally), so feeds never bleed into one another even on parse failure.
 *  - Negative durations (malformed DTEND < DTSTART) are skipped and counted,
 *    never fabricate an occurrence.
 *  - The candidate budget counts what was examined for THIS query; when any
 *    guard trips the series is marked incomplete so free-slot output can be
 *    flagged degraded instead of confidently wrong.
 */

import ICAL from "ical.js";
import {
  assertValidTimeZone,
  wallTimeToInstant,
  localDateString,
  startOfLocalDay,
  addDays,
} from "./time.js";

// ---------------------------------------------------------------------------

export interface EventMeta {
  uid: string;
  title: string;
  location: string | undefined;
  status: string;
  transparent: boolean;
  recurring: boolean;
}

export interface SourceEvent extends EventMeta {
  event: ICAL.Event;
}

export interface ParsedCalendar {
  events: SourceEvent[];
  warnings: string[];
  skippedEvents: number;
  hasVtimezone: boolean;
  /** TZIDs this feed registered for THIS expansion (cleaned up afterwards). */
  registeredTzids: string[];
}

function what(error: unknown): string {
  return error instanceof Error ? error.name : String(error);
}

/**
 * Cheap parseability gate used before freshly fetched bytes may evict the
 * cached good copy: throws when the payload is not valid ICS.
 */
export function assertParseable(raw: string): void {
  let jcal: unknown;
  try {
    jcal = ICAL.parse(raw);
  } catch (error) {
    throw new Error(`parse failed (${what(error)})`);
  }
  const comp = new ICAL.Component(jcal as never);
  if (comp.name !== "vcalendar") throw new Error("payload is not a VCALENDAR");
}

export function parseCalendar(
  feedId: string,
  raw: string,
  registrationTracker?: { tzids: string[] },
): ParsedCalendar {
  const warnings: string[] = [];
  let jcal: unknown;
  try {
    jcal = ICAL.parse(raw);
  } catch (error) {
    throw new Error(`feed ${feedId}: parse failed (${what(error)})`);
  }
  const comp = new ICAL.Component(jcal as never);
  const vtimezones = comp.getAllSubcomponents("vtimezone");
  const hasVtimezone = vtimezones.length > 0;

  const registeredTzids: string[] = [];
  for (const vt of vtimezones) {
    const tzid = (vt.getFirstPropertyValue("tzid") as string | null) ?? undefined;
    if (!tzid) continue;
    if (ICAL.TimezoneService.get(tzid)) continue; // first wins; never clobber
    try {
      ICAL.TimezoneService.register(new ICAL.Timezone(vt));
      registeredTzids.push(tzid);
      registrationTracker?.tzids.push(tzid);
    } catch (error) {
      warnings.push(`VTIMEZONE ${tzid} failed to register (${what(error)})`);
    }
  }

  // Any TZID that still does not resolve is a silent-corruption risk: ical.js
  // would treat its wall time as UTC. Loud warning once per TZID.
  const unknownTzids = new Set<string>();
  walkTzidParams(comp, (tzid) => {
    if (!ICAL.TimezoneService.get(tzid)) unknownTzids.add(tzid);
  });
  for (const tzid of unknownTzids) {
    warnings.push(
      `TZID "${tzid}" has no VTIMEZONE and is not builtin; its wall times are interpreted in the configured zone`,
    );
  }

  // Group VEVENTs by UID: masters carry no RECURRENCE-ID, overrides attach
  // through ICAL.Event's exceptions machinery (single linear pass, no O(n²)
  // parent scans per Event constructor).
  const overridesByUid = new Map<string, ICAL.Component[]>();
  const masters: ICAL.Component[] = [];
  for (const vevent of comp.getAllSubcomponents("vevent")) {
    if (vevent.hasProperty("recurrence-id")) {
      const uid = String(vevent.getFirstPropertyValue("uid") ?? "");
      const list = overridesByUid.get(uid) ?? [];
      list.push(vevent);
      overridesByUid.set(uid, list);
    } else {
      masters.push(vevent);
    }
  }

  const events: SourceEvent[] = [];
  let skippedEvents = 0;
  for (const vevent of masters) {
    let event: ICAL.Event;
    try {
      const uid = String(vevent.getFirstPropertyValue("uid") ?? "");
      const exceptions = (overridesByUid.get(uid) ?? []).map(
        (c) => new ICAL.Event(c, { exceptions: [] }),
      );
      event = new ICAL.Event(vevent, { exceptions });
    } catch {
      skippedEvents++;
      continue;
    }
    try {
      events.push({
        uid: event.uid ?? "",
        title: event.summary ?? "",
        location: event.location ?? undefined,
        status: String(event.component.getFirstPropertyValue("status") ?? "").toUpperCase(),
        transparent:
          String(event.component.getFirstPropertyValue("transp") ?? "").toUpperCase() ===
          "TRANSPARENT",
        recurring: event.isRecurring(),
        event,
      });
    } catch {
      skippedEvents++;
    }
  }

  return { events, warnings, skippedEvents, hasVtimezone, registeredTzids };
}

function walkTzidParams(comp: ICAL.Component, visit: (tzid: string) => void): void {
  for (const prop of comp.getAllProperties() as ICAL.Property[]) {
    if (prop.name === "tzid") continue;
    const tzid = prop.getParameter?.("tzid") as string | undefined;
    if (tzid) visit(tzid);
  }
  for (const sub of comp.getAllSubcomponents() as ICAL.Component[]) {
    walkTzidParams(sub, visit);
  }
}

/** Remove timezones this feed registered so they cannot leak into other feeds. */
export function cleanupRegisteredTimezones(tzids: string[]): void {
  for (const tzid of tzids) {
    try {
      ICAL.TimezoneService.remove(tzid);
    } catch {
      // already gone — nothing to clean
    }
  }
}

// ---------------------------------------------------------------------------

export interface Occurrence {
  uid: string;
  title: string;
  location: string | undefined;
  start: Date;
  end: Date;
  startDate: string; // YYYY-MM-DD in display timezone
  endDateExclusive: string;
  allDay: boolean;
  status: string;
  transparent: boolean;
  recurring: boolean;
}

export interface Expansion {
  occurrences: Occurrence[];
  incompleteSeries: string[];
  warnings: string[];
  skippedEvents: number;
}

export interface ExpandConfig {
  displayTimeZone: string;
  from: Date;
  to: Date;
}

/** Per-series examined-candidate cap, then the series is marked incomplete. */
const MAX_CANDIDATES_PER_SERIES = 5000;

/** One-shot: parse a feed body and expand it inside a window, cleaning up zones. */
export function expandFeed(feedId: string, raw: string, config: ExpandConfig): Expansion {
  const tracker = { tzids: [] as string[] };
  try {
    const parsed = parseCalendar(feedId, raw, tracker);
    return expandCalendar(parsed, config);
  } finally {
    // Always detach this feed's VTIMEZONEs, even on parse failure midway.
    cleanupRegisteredTimezones(tracker.tzids);
  }
}

/** icalTime -> real instant; floating/unresolved is interpreted in `zone`. */
function icalTimeToInstant(icalTime: ICAL.Time, zone: string): Date {
  if (icalTime.zone !== ICAL.Timezone.localTimezone) {
    return new Date(icalTime.toUnixTime() * 1000);
  }
  return wallTimeToInstant(
    icalTime.year,
    icalTime.month,
    icalTime.day,
    icalTime.hour,
    icalTime.minute,
    icalTime.second,
    zone,
  );
}

/** Wall-time ordering without subtractDate's ambiguous zone semantics. */
function timeIsBeforeOrEqual(a: ICAL.Time, b: ICAL.Time): boolean {
  try {
    return a.compare(b) <= 0;
  } catch {
    return true; // incomparable (mixed types) — let downstream handle it
  }
}

// ---------------------------------------------------------------------------
// Occurrence building — endpoints are converted INDEPENDENTLY, never start+s.

function buildOccurrence(
  meta: EventMeta,
  startIcal: ICAL.Time,
  endIcal: ICAL.Time | null,
  config: ExpandConfig,
): Occurrence | null {
  if (startIcal.isDate) {
    const startDate = `${pad4(startIcal.year)}-${pad2(startIcal.month)}-${pad2(startIcal.day)}`;
    const start = startOfLocalDay(startDate, config.displayTimeZone);
    // Nominal day arithmetic: P1D means "next local calendar day", not +86400s.
    const endDateExclusive = endIcal
      ? `${pad4(endIcal.year)}-${pad2(endIcal.month)}-${pad2(endIcal.day)}`
      : addDays(startDate, 1);
    const end = startOfLocalDay(endDateExclusive, config.displayTimeZone);
    if (start.getTime() >= config.to.getTime() || end.getTime() <= config.from.getTime()) {
      return null;
    }
    return { ...meta, start, end, startDate, endDateExclusive, allDay: true };
  }

  const start = icalTimeToInstant(startIcal, config.displayTimeZone);
  const end = endIcal
    ? icalTimeToInstant(endIcal, config.displayTimeZone)
    : start;
  if (start.getTime() >= config.to.getTime() || end.getTime() <= config.from.getTime()) {
    return null;
  }
  const startDate = localDateString(start, config.displayTimeZone);
  return {
    ...meta,
    start,
    end,
    startDate,
    endDateExclusive: localDateString(end, config.displayTimeZone),
    allDay: false,
  };
}

// ---------------------------------------------------------------------------

export function expandCalendar(parsed: ParsedCalendar, config: ExpandConfig): Expansion {
  assertValidTimeZone(config.displayTimeZone);
  const warnings = [...parsed.warnings];
  const incompleteSeries: string[] = [];
  const occurrences: Occurrence[] = [];
  let skippedEvents = parsed.skippedEvents;

  for (const source of parsed.events) {
    try {
      skippedEvents = expandOne(source, config, occurrences, incompleteSeries, warnings, skippedEvents);
    } catch (error) {
      skippedEvents++;
      warnings.push(
        `event ${source.uid} (${source.title || "bez názvu"}) skipped (${what(error)})`,
      );
    }
  }

  // Closest-first ordering, stable: by start instant, all-day first in a tie.
  occurrences.sort((a, b) => {
    const delta = a.start.getTime() - b.start.getTime();
    if (delta !== 0) return delta;
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return a.title < b.title ? -1 : 1;
  });
  return { occurrences, incompleteSeries, warnings, skippedEvents };
}

// ---------------------------------------------------------------------------

function exceptionMeta(source: SourceEvent, exception: ICAL.Event): EventMeta {
  // Override metadata comes from the exception's own component; the master only
  // fills gaps (an override without STATUS keeps the master's STATUS).
  const read = (name: string): string | undefined => {
    try {
      const value = exception.component.getFirstPropertyValue(name);
      return value != null ? String(value) : undefined;
    } catch {
      return undefined;
    }
  };
  const status = (read("status") ?? source.status).toUpperCase();
  const transp = read("transp");
  return {
    uid: source.uid,
    title: (() => {
      try {
        return exception.summary ?? source.title;
      } catch {
        return source.title;
      }
    })(),
    location: (() => {
      try {
        return exception.location ?? source.location;
      } catch {
        return source.location;
      }
    })(),
    status,
    transparent:
      transp != null ? transp.toUpperCase() === "TRANSPARENT" : source.transparent,
    recurring: source.recurring,
  };
}

function recurrenceKey(time: ICAL.Time): string {
  // ICAL relateException keys exceptions by obj.recurrenceId.toString(); use the
  // exact same encoding so the lookup here mirrors that map's keys.
  return time.toString();
}

function exceptionsRecord(source: SourceEvent): Record<string, ICAL.Event> {
  return (source.event.exceptions ?? Object.create(null)) as unknown as Record<
    string,
    ICAL.Event
  >;
}

function suppressableOriginals(source: SourceEvent): Set<string> {
  return new Set(Object.keys(exceptionsRecord(source)));
}

/** Emit exception occurrences by their MOVED interval, regardless of where the
 *  original recurrence-id lies relative to the window (fixes moved-in miss). */
function emitExceptions(
  source: SourceEvent,
  config: ExpandConfig,
  out: Occurrence[],
  warnings: string[],
  skipped: number,
): number {
  const exceptions = Object.values(exceptionsRecord(source));
  let skippedEvents = skipped;
  for (const exception of exceptions) {
    try {
      const exStart = exception.startDate;
      if (!exStart) continue;
      // RANGE=THISANDFUTURE anchors are emitted at their new start too; the rest
      // of the restated series is covered by the incompleteSeries marker.
      let exEnd: ICAL.Time | null = null;
      try {
        exEnd = exception.endDate;
      } catch {
        exEnd = null;
      }
      if (exEnd && !timeIsBeforeOrEqual(exStart, exEnd)) {
        skippedEvents++;
        warnings.push(`override of ${source.uid}: negative duration, skipped`);
        continue;
      }
      const meta = exceptionMeta(source, exception);
      const occurrence = buildOccurrence(meta, exStart, exEnd, config);
      if (occurrence) out.push(occurrence);
    } catch (error) {
      skippedEvents++;
      warnings.push(`override of ${source.uid} skipped (${what(error)})`);
    }
  }
  return skippedEvents;
}

function expandOne(
  source: SourceEvent,
  config: ExpandConfig,
  occurrences: Occurrence[],
  incompleteSeries: string[],
  warnings: string[],
  skippedEventsIn: number,
): number {
  let skippedEvents = skippedEventsIn;
  const { event } = source;
  const startIcal = event.startDate;
  if (!startIcal) {
    return skippedEvents + 1;
  }

  let endIcal: ICAL.Time | null = null;
  try {
    endIcal = event.endDate;
  } catch {
    endIcal = null;
  }
  if (endIcal && !timeIsBeforeOrEqual(startIcal, endIcal)) {
    warnings.push(`event ${source.uid} (${source.title || "?"}): DTEND < DTSTART, skipped`);
    return skippedEvents + 1;
  }

  // Recurrence duration straight from ical.js (covers explicit DURATION and
  // DTSTART/DTEND); negative durations are always rejected.
  let masterDuration: ICAL.Duration | null = null;
  try {
    masterDuration = event.duration;
  } catch {
    masterDuration = null;
  }
  if (masterDuration && masterDuration.toSeconds() < 0) {
    warnings.push(`event ${source.uid} (${source.title || "?"}): negative duration, skipped`);
    return skippedEvents + 1;
  }

  if (!source.recurring) {
    const one = buildOccurrence(source, startIcal, endIcal, config);
    if (one) occurrences.push(one);
    return skippedEvents;
  }

  // --- exceptions pass (independent of the master-window prefilter) ---
  skippedEvents = emitExceptions(source, config, occurrences, warnings, skippedEvents);
  const suppressed = suppressableOriginals(source);

  const rangeExceptions = event.rangeExceptions ?? [];
  if (rangeExceptions.length > 0) {
    // THISANDFUTURE full semantics (restated series with a new RRULE) are out
    // of scope; suppress overridden originals and mark the series incomplete
    // rather than show confidently-wrong data for the tail of the series.
    incompleteSeries.push(`${source.uid || "?"} (RANGE=THISANDFUTURE)`);
  }

  const expansion = new ICAL.RecurExpansion({
    component: event.component,
    dtstart: startIcal,
  });

  const windowStartMs = config.from.getTime();
  const windowEndMs = config.to.getTime();
  const durationSec = masterDuration ? Math.max(0, masterDuration.toSeconds()) : 0;
  const durationMs = durationSec * 1000;
  let examined = 0;
  let overshoot = 0;
  let hitGuard = false;

  for (let guard = 0; ; guard++) {
    if (guard >= MAX_CANDIDATES_PER_SERIES * 4) {
      // Raw-history guard spent without reaching the window (dense old series):
      // mark incomplete instead of silently returning nothing (Sol round-2 #4).
      incompleteSeries.push(`${source.uid || "?"}`);
      break;
    }
    let next: ICAL.Time | null = null;
    try {
      next = expansion.next();
    } catch (error) {
      incompleteSeries.push(`${source.uid || "?"}`);
      warnings.push(`series ${source.uid}: iteration aborted (${what(error)})`);
      break;
    }
    if (!next) break;

    // Cheap-skip candidates that cannot overlap; the budget then counts what
    // was actually examined for THIS query, not raw history length (Sol #4).
    const startMsGuess = icalTimeToInstant(next, config.displayTimeZone).getTime();
    const endMsGuess = startMsGuess + durationMs;
    if (endMsGuess <= windowStartMs) continue;
    if (startMsGuess > windowEndMs) {
      overshoot++;
      if (overshoot >= 2) break; // expansion is chronological by start
    }

    examined++;
    if (examined > MAX_CANDIDATES_PER_SERIES) {
      hitGuard = true;
      break;
    }

    // Direct override for this candidate? Suppressed already by emitExceptions;
    // skip the original to kill the ghost.
    if (suppressed.has(recurrenceKey(next))) continue;

    // RANGE=THISANDFUTURE: suppress the original at and after the range point.
    if (rangeExceptions.length > 0) {
      const rangeException = safeFindRangeException(event, next);
      if (rangeException) continue;
    }

    const one = buildOccurrence(source, next, endForOccurrence(next, masterDuration), config);
    if (one) occurrences.push(one);
  }
  if (hitGuard) {
    // A spent guard must surface as incomplete, not silently wrong data.
    incompleteSeries.push(`${source.uid || "?"}`);
  }
  return skippedEvents;
}

function safeFindRangeException(event: ICAL.Event, next: ICAL.Time): ICAL.Event | null {
  try {
    return event.findRangeException(next);
  } catch {
    return null;
  }
}

/** Nominal end of an occurrence: wall-time addition via ICAL addDuration. */
function endForOccurrence(startIcal: ICAL.Time, duration: ICAL.Duration | null): ICAL.Time {
  const endIcal = startIcal.clone();
  if (!duration) return endIcal;
  try {
    endIcal.addDuration(duration);
  } catch {
    // Duration couldn't be applied — leave a zero-length occurrence rather than stall.
  }
  return endIcal;
}

// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function pad4(n: number): string {
  return String(n).padStart(4, "0");
}
