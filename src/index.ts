/**
 * openclaw-ical — a read-only agenda reader over ICS subscription feeds.
 *
 * One tool: `ical_events` — "what do I have between X and Y". Deliberately
 * NOT a scheduling engine (availability computation was removed 2026-09-06;
 * the model can reason about gaps from the event list itself).
 *
 * Output contract: one representation per value, honest partial/stale/degraded
 * indicators, all strings passing through the secret redactor.
 */
import { Type, type Static } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/config-runtime";

import {
  FeedCache,
  ensureFeed,
  makeRedactor,
  resolveFeedUrl,
  DEFAULT_TTL_MS,
  DEFAULT_FETCH_TIMEOUT_MS,
  type FeedConfig,
  type FetchLike,
  type RefResolver,
} from "./feed.js";
import { expandFeed, assertParseable, type Occurrence } from "./calendar.js";
import { localDateString, splitDate, toLocalIso, wallTimeToInstant, addDays, assertValidTimeZone } from "./time.js";

// ---------------------------------------------------------------------------
// Config schema

const SecretRefConfig = Type.Object(
  {
    provider: Type.Optional(Type.String()),
    source: Type.String({ description: "SecretRef source, e.g. env" }),
    id: Type.String({ description: "SecretRef id (store entry name)" }),
  },
  { description: "OpenClaw SecretRef resolved by the host secrets runtime (0.1.2+)." },
);

const CalendarConfig = Type.Object({
  id: Type.String({
    minLength: 1,
    pattern: "^[a-z0-9][a-z0-9_-]*$",
    description: "Short id the agent uses to select this calendar.",
  }),
  name: Type.Optional(Type.String({ description: "Human-friendly label for output." })),
  url: Type.Optional(
    Type.Union([Type.String({ minLength: 1 }), SecretRefConfig], {
      description:
        "ICS feed: public https URL string, OR an OpenClaw SecretRef object resolved by the host secrets runtime (preferred for private feeds like Google's 'secret address in iCal format'). Mutually exclusive with secretEnv.",
    }),
  ),
  secretEnv: Type.Optional(
    Type.String({
      pattern: "^[A-Z][A-Z0-9_]*$",
      description:
        "Legacy alternative to SecretRef url: env var holding the COMPLETE private feed URL. Mutually exclusive with url.",
    }),
  ),
});

const PluginConfig = Type.Object({
  calendars: Type.Array(CalendarConfig, { minItems: 1 }),
  timezone: Type.Optional(
    Type.String({
      description:
        "IANA timezone for all-day boundaries, floating times and rendering. Default: host timezone.",
    }),
  ),
});

type PluginConfigT = Static<typeof PluginConfig>;

// ---------------------------------------------------------------------------
// Runtime resolution

export interface Runtime {
  feeds: FeedConfig[];
  displayTimeZone: string;
  redact: (s: string) => string;
  cache: FeedCache;
  /** Test seam: inject a fetch implementation instead of global fetch. */
  fetchImpl?: FetchLike;
  /** Resolves SecretRef urls when supplied by the host runtime (0.1.2+). */
  resolveRef?: RefResolver;
}

const MAX_WINDOW_DAYS = 400;
const MAX_EVENTS = 500;

export async function resolveRuntimeAsync(
  config: PluginConfigT,
  cache: FeedCache = new FeedCache(),
  resolveRef?: RefResolver,
): Promise<Runtime> {
  const displayTimeZone =
    config.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  assertValidTimeZone(displayTimeZone);
  const feeds: FeedConfig[] = config.calendars.map((c) => ({
    id: c.id,
    name: c.name ?? c.id,
    ...(c.url !== undefined && c.url !== null ? { url: c.url } : {}),
    ...(c.secretEnv ? { secretEnv: c.secretEnv } : {}),
  }));
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const f of feeds) {
    if (seen.has(f.id)) throw new Error(`duplicate calendar id "${f.id}"`);
    seen.add(f.id);
    // Fail fast at load time on contradictory/missing URL config.
    try {
      urls.push(await resolveFeedUrl(f, resolveRef));
    } catch {
      urls.push("");
      // Surface config errors on the original path (sync resolve for config validation).
      await resolveFeedUrl(f, resolveRef);
    }
  }
  return {
    feeds,
    displayTimeZone,
    redact: makeRedactor(urls),
    cache,
    ...(resolveRef ? { resolveRef } : {}),
  };
}

// ---------------------------------------------------------------------------
// Loading + expansion with per-feed fault isolation

interface FeedOccurrence extends Occurrence {
  feedId: string;
  calendarName: string;
}

interface LoadResult {
  occurrences: FeedOccurrence[];
  incompleteSeries: string[];
  feedErrors: { feedId: string; message: string }[];
  staleFeeds: { feedId: string; ageSeconds: number }[];
  warnings: string[];
  skippedEvents: number;
  failedFeeds: number;
}

async function loadFeeds(
  runtime: Runtime,
  feeds: FeedConfig[],
  windowStart: Date,
  windowEnd: Date,
): Promise<LoadResult> {
  const result: LoadResult = {
    occurrences: [],
    incompleteSeries: [],
    feedErrors: [],
    staleFeeds: [],
    warnings: [],
    skippedEvents: 0,
    failedFeeds: 0,
  };

  await Promise.all(
    feeds.map(async (feed) => {
      let raw: string;
      try {
        const outcome = await ensureFeed(
          feed,
          DEFAULT_TTL_MS,
          DEFAULT_FETCH_TIMEOUT_MS,
          runtime.cache,
          assertParseable,
          runtime.fetchImpl,
          runtime.resolveRef,
        );
        if (outcome.stale) {
          result.staleFeeds.push({ feedId: feed.id, ageSeconds: outcome.ageSeconds ?? 0 });
        }
        raw = outcome.raw;
      } catch (error) {
        result.failedFeeds++;
        result.feedErrors.push({
          feedId: feed.id,
          message: runtime.redact(error instanceof Error ? error.message : String(error)),
        });
        return;
      }
      try {
        const expansion = expandFeed(feed.id, raw, {
          displayTimeZone: runtime.displayTimeZone,
          from: windowStart,
          to: windowEnd,
        });
        for (const occ of expansion.occurrences) {
          result.occurrences.push({ ...occ, feedId: feed.id, calendarName: feed.name });
        }
        for (const w of expansion.warnings) {
          result.warnings.push(`[${feed.id}] ${runtime.redact(w)}`);
        }
        for (const series of expansion.incompleteSeries) {
          result.incompleteSeries.push(`${feed.id}:${series}`);
        }
        result.skippedEvents += expansion.skippedEvents;
      } catch (error) {
        result.failedFeeds++;
        result.feedErrors.push({
          feedId: feed.id,
          message: runtime.redact(error instanceof Error ? error.message : String(error)),
        });
      }
    }),
  );

  result.incompleteSeries.sort();
  result.occurrences.sort((a, b) => a.start.getTime() - b.start.getTime());
  return result;
}

// ---------------------------------------------------------------------------
// Input parsing helpers

function fold(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

const OFFSETLESS_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

function parseDateOrNow(input: string | undefined, now: Date, timeZone: string): Date {
  if (!input) return now;
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const [y, m, d] = splitDate(input);
    return wallTimeToInstant(y, m, d, 0, 0, 0, timeZone);
  }
  if (OFFSETLESS_DATETIME.test(input)) {
    // Offsetless ISO datetimes resolve in the CONFIGURED zone, never the host zone.
    const [datePart, timePart] = input.split("T");
    const [y, m, d] = splitDate(datePart);
    const [hh, mm, ss] = timePart.split(":").map(Number);
    return wallTimeToInstant(y, m, d, hh ?? 0, mm ?? 0, ss ?? 0, timeZone);
  }
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) throw new Error(`invalid date/datetime "${input}"`);
  return parsed;
}

function pickFeeds(runtime: Runtime, calendar: string | undefined): FeedConfig[] | { error: string } {
  if (!calendar) return runtime.feeds;
  const found = runtime.feeds.filter((f) => f.id === calendar);
  if (found.length === 0) {
    const known = runtime.feeds.map((f) => f.id).join(", ");
    return { error: `unknown calendar id "${calendar}". Known: ${known}` };
  }
  return found;
}

// ---------------------------------------------------------------------------
// Tool parameters

const EventsParams = Type.Object({
  from: Type.Optional(
    Type.String({ description: "Window start: YYYY-MM-DD or ISO datetime. Default: now." }),
  ),
  to: Type.Optional(
    Type.String({ description: "Window end (exclusive). Default: from + 14 local days." }),
  ),
  calendar: Type.Optional(Type.String({ description: "Only this calendar id. Default: all." })),
  query: Type.Optional(
    Type.String({ description: "Case- and diacritics-insensitive substring on title/location." }),
  ),
  includeAllDay: Type.Optional(Type.Boolean({ description: "Include all-day events. Default: true." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
});

export async function executeEvents(
  params: Static<typeof EventsParams>,
  runtime: Runtime,
) {
  try {
    const now = new Date();
    const start = parseDateOrNow(params.from, now, runtime.displayTimeZone);
    let end: Date;
    if (params.to) {
      end = parseDateOrNow(params.to, now, runtime.displayTimeZone);
    } else {
      // Local-day arithmetic: "+14 days" lands on a local midnight even across DST.
      const startDate = localDateString(start, runtime.displayTimeZone);
      const [ey, em, ed] = splitDate(addDays(startDate, 14));
      end = wallTimeToInstant(ey, em, ed, 0, 0, 0, runtime.displayTimeZone);
    }
    if (!(end.getTime() > start.getTime())) {
      return {
        error: `to must be after from (from=${params.from ?? "now"} to=${params.to ?? "+14d"})`,
      };
    }
    const days = (end.getTime() - start.getTime()) / 86_400_000;
    if (days > MAX_WINDOW_DAYS) {
      return { error: `window too long (${Math.ceil(days)} days, max ${MAX_WINDOW_DAYS}); narrow the range` };
    }

    const limit = Math.min(params.limit ?? 100, MAX_EVENTS);
    const feeds = pickFeeds(runtime, params.calendar);
    if (!Array.isArray(feeds)) return feeds;

    const load = await loadFeeds(runtime, feeds, start, end);
    if (feeds.length > 0 && load.failedFeeds === feeds.length) {
      return {
        error: `all ${feeds.length} calendar feed(s) failed to load`,
        feedErrors: load.feedErrors,
      };
    }

    let occs = load.occurrences;
    if (params.includeAllDay === false) occs = occs.filter((o) => !o.allDay);
    if (params.query) {
      const needle = fold(params.query);
      occs = occs.filter(
        (o) =>
          fold(o.title).includes(needle) ||
          (o.location ? fold(o.location).includes(needle) : false),
      );
    }
    const totalMatches = occs.length;
    const truncated = totalMatches > limit;
    const events = occs.slice(0, limit).map((o) => ({
      calendarId: o.feedId,
      calendar: runtime.redact(o.calendarName),
      title: runtime.redact(o.title),
      start: o.allDay ? o.startDate : toLocalIso(o.start, runtime.displayTimeZone),
      end: o.allDay ? o.endDateExclusive : toLocalIso(o.end, runtime.displayTimeZone),
      allDay: o.allDay,
      ...(o.location ? { location: runtime.redact(o.location) } : {}),
      ...(o.status ? { status: o.status } : {}),
      ...(o.recurring ? { recurring: true } : {}),
    }));

    const notes: string[] = [];
    if (load.staleFeeds.length) {
      notes.push(
        "Serving cached data because a refetch failed. ageSeconds is seconds since the last successful fetch.",
      );
    }
    if (load.incompleteSeries.length) {
      notes.push("Some recurring series exceeded the expansion budget; later occurrences may be missing.");
    }
    if (load.skippedEvents > 0) {
      notes.push(`${load.skippedEvents} event(s) failed to parse and were skipped.`);
    }
    if (load.failedFeeds > 0) {
      notes.push(`${load.failedFeeds} of ${feeds.length} feed(s) failed; result is partial.`);
    }

    return {
      window: {
        from: toLocalIso(start, runtime.displayTimeZone),
        to: toLocalIso(end, runtime.displayTimeZone),
        timezone: runtime.displayTimeZone,
      },
      calendars: feeds.map((f) => ({ id: f.id, name: runtime.redact(f.name) })),
      totalMatches,
      returnedCount: events.length,
      truncated,
      partial: load.failedFeeds > 0 || load.skippedEvents > 0 || load.incompleteSeries.length > 0,
      events,
      stale: load.staleFeeds.length > 0,
      ...(load.staleFeeds.length ? { staleFeeds: load.staleFeeds } : {}),
      ...(load.incompleteSeries.length ? { incompleteSeries: load.incompleteSeries.map((s) => runtime.redact(s)) } : {}),
      ...(load.skippedEvents > 0 ? { skippedEvents: load.skippedEvents } : {}),
      ...(load.feedErrors.length ? { feedErrors: load.feedErrors } : {}),
      ...(notes.length ? { notes } : {}),
      ...(load.warnings.length ? { warnings: load.warnings.slice(0, 20) } : {}),
    };
  } catch (error) {
    return {
      error: (() => {
        const msg = error instanceof Error ? error.message : String(error);
        // redact needs runtime; available in closure
        return runtime.redact(msg);
      })(),
    };
  }
}

// ---------------------------------------------------------------------------
// Plugin entry

const sharedCache = new FeedCache();

export default defineToolPlugin({
  id: "openclaw-ical",
  name: "iCal Calendar",
  description:
    "Read-only agenda reader over ICS subscription feeds (Google, iCloud, Fastmail, Nextcloud).",
  configSchema: PluginConfig,
  tools: (tool) => [
    tool({
      name: "ical_events",
      description:
        "List calendar events overlapping a window. Times are ISO 8601 with local offset; all-day events carry date-only start/end where end is EXCLUSIVE (the day AFTER the last covered day, per RFC 5545). Answers 'what do I have when?' — including stale/partial/truncated indicators when data is incomplete.",
      parameters: EventsParams,
      execute: async (params, config, context) => {
        const resolveRef: RefResolver | undefined = context?.api?.config
          ? async (ref) => {
              const out = await resolveConfiguredSecretInputString({
                config: context.api.config,
                env: process.env,
                value: ref,
                path: `plugins.entries.openclaw-ical.config.calendars[].url`,
              });
              if (!out.value) {
                throw new Error(out.unresolvedRefReason ?? `SecretRef ${ref.id} unresolved`);
              }
              return out.value;
            }
          : undefined;
        const runtime = await resolveRuntimeAsync(config, sharedCache, resolveRef);
        return executeEvents(params, runtime);
      },
    }),
  ],
});
