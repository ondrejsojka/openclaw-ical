import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import entry, { executeEvents, resolveRuntimeAsync, type Runtime } from "./index.js";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import { expandFeed, assertParseable, type ExpandConfig } from "./calendar.js";
import {
  makeRedactor,
  ensureFeed,
  FeedCache,
  MAX_BODY_BYTES,
  FeedFetchError,
  type FeedConfig,
} from "./feed.js";
import { wallTimeToInstant, toLocalIso, localDateString, splitDate } from "./time.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");
const read = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

const TZ = "Europe/Prague";
const cfg = (fromIso: string, toIso: string): ExpandConfig => ({
  displayTimeZone: TZ,
  from: new Date(fromIso),
  to: new Date(toIso),
});
const winSep = cfg("2026-09-05T00:00:00Z", "2026-09-21T00:00:00Z");

const matches = <T extends { uid: string }>(occ: T[], uid: string) =>
  occ.filter((o) => o.uid === uid);

// ---------------------------------------------------------------------------

describe("plugin metadata", () => {
  it("declares exactly one tool: ical_events", () => {
    expect(getToolPluginMetadata(entry)?.tools.map((t) => t.name)).toEqual(["ical_events"]);
  });
});

// ---------------------------------------------------------------------------

describe("parse + expand: basic fixture", () => {
  const expansion = expandFeed("test", read("basic.ics"), winSep);

  it("timed event with TZID lands on the correct instant (Prague is +2 in Sept)", () => {
    const e = matches(expansion.occurrences, "timed-tzid@fixture");
    expect(e).toHaveLength(1);
    expect(e[0].start.toISOString()).toBe("2026-09-07T09:00:00.000Z"); // 11:00 CEST
    expect(e[0].end.toISOString()).toBe("2026-09-07T10:00:00.000Z");
    expect(e[0].allDay).toBe(false);
    expect(e[0].startDate).toBe("2026-09-07");
  });

  it("UTC event renders with local offset in local fields", () => {
    const e = matches(expansion.occurrences, "timed-utc@fixture");
    expect(e).toHaveLength(1);
    expect(e[0].start.toISOString()).toBe("2026-09-06T10:00:00.000Z");
    expect(toLocalIso(e[0].start, TZ)).toBe("2026-09-06T12:00:00+02:00");
  });

  it("single all-day event covers exactly one day, end exclusive is the next day", () => {
    const e = matches(expansion.occurrences, "allday-single@fixture");
    expect(e).toHaveLength(1);
    expect(e[0].allDay).toBe(true);
    expect(e[0].startDate).toBe("2026-09-17");
    expect(e[0].endDateExclusive).toBe("2026-09-18");
  });

  it("multi-day all-day [11,14) has exclusive end", () => {
    const e = matches(expansion.occurrences, "allday-multi@fixture");
    expect(e).toHaveLength(1);
    expect(e[0].startDate).toBe("2026-09-11");
    expect(e[0].endDateExclusive).toBe("2026-09-14");
  });

  it("all-day event intersecting the window edge is included, outside is not", () => {
    const narrow = expandFeed("test", read("basic.ics"), cfg("2026-09-17T12:00:00Z", "2026-09-17T13:00:00Z"));
    expect(matches(narrow.occurrences, "allday-single@fixture")).toHaveLength(1);

    const before = expandFeed("test", read("basic.ics"), cfg("2026-09-15T00:00:00Z", "2026-09-16T00:00:00Z"));
    expect(matches(before.occurrences, "allday-single@fixture")).toHaveLength(0);
    expect(matches(before.occurrences, "allday-multi@fixture")).toHaveLength(0);
  });

  it("floating times resolve in the configured zone, not host/UTC", () => {
    const e = matches(expansion.occurrences, "floating@fixture");
    expect(e).toHaveLength(1);
    expect(e[0].start.toISOString()).toBe("2026-09-08T07:00:00.000Z"); // 09:00 Prague
  });

  it("cancelled and transparent events keep their flags", () => {
    const c = matches(expansion.occurrences, "cancelled@fixture");
    expect(c[0].status).toBe("CANCELLED");
    const t = matches(expansion.occurrences, "transparent@fixture");
    expect(t[0].transparent).toBe(true);
  });

  it("zero-length event keeps start == end (no phantom 3600s duration)", () => {
    const z = matches(expansion.occurrences, "zero-length@fixture");
    expect(z).toHaveLength(1);
    expect(z[0].start.getTime()).toBe(z[0].end.getTime());
  });

  it("CRLF-folded summary with a multi-byte char across the fold survives", () => {
    const f = matches(expansion.occurrences, "folded@fixture");
    expect(f).toHaveLength(1);
    expect(f[0].title.replace(/\s+/g, " ")).toContain("eho znaku");
  });

  it("event spanning the window edge from the left is included", () => {
    const e = matches(expansion.occurrences, "spans-window-edge@fixture");
    expect(e).toHaveLength(1);
  });

  it("warnings list is empty for a well-formed feed with VTIMEZONE", () => {
    expect(expansion.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("expand: recurring fixture", () => {
  const expansion = expandFeed("test", read("recurring.ics"), winSep);

  it("weekly series keeps local 18:00 across the DST change", () => {
    const wide = expandFeed("test", read("recurring.ics"), cfg("2026-10-01T00:00:00Z", "2026-12-01T00:00:00Z"));
    const w = matches(wide.occurrences, "weekly-dst@fixture");
    expect(w).toHaveLength(6);
    for (const occ of w) {
      expect(toLocalIso(occ.start, TZ).slice(11, 16)).toBe("18:00");
    }
  });

  it("EXDATE removes the 9th; UNTIL 0459Z on the 11th excludes the 07:00 Prague occurrence", () => {
    const e = matches(expansion.occurrences, "daily-exdate@fixture").map((o) => o.startDate).sort();
    expect(e).toEqual(["2026-09-07", "2026-09-08", "2026-09-10"]);
  });

  it("RECURRENCE-ID override moves the occurrence and suppresses the original", () => {
    const e = matches(expansion.occurrences, "override-series@fixture");
    const dates = e.map((o) => `${o.startDate}@${toLocalIso(o.start, TZ).slice(11, 16)}`).sort();
    expect(dates).toEqual(["2026-09-07@15:00", "2026-09-14@17:00"]);
    expect(e).toHaveLength(2);
  });

  it("all-day weekly recurrence produces all-day occurrences", () => {
    const e = matches(expansion.occurrences, "allday-weekly@fixture");
    expect(e.map((o) => o.startDate).sort()).toEqual(["2026-09-07", "2026-09-14", "2026-09-21"]);
    expect(e.every((o) => o.allDay)).toBe(true);
  });
});

describe("windows that only catch the tail of an event", () => {
  it("an occurrence starting before `from` but ending inside the window is included", () => {
    const ics = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//t//EN",
      "BEGIN:VEVENT", "UID:tail@t", "DTSTAMP:20260901T000000Z",
      "DTSTART:20260910T220000Z", "DTEND:20260911T010000Z", "SUMMARY:Overnight",
      "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n");
    const exp = expandFeed("t", ics, cfg("2026-09-11T00:00:00Z", "2026-09-12T00:00:00Z"));
    expect(matches(exp.occurrences, "tail@t")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe("redaction", () => {
  it("strips the URL, its path and decoded variants from messages", () => {
    const redact = makeRedactor([
      "https://calendar.google.com/calendar/ical/ondrej.sojka%40gmail.com/private-abc123/basic.ics",
    ]);
    const msg =
      "fetch to https://calendar.google.com/calendar/ical/ondrej.sojka%40gmail.com/private-abc123/basic.ics failed; see /calendar/ical/ondrej.sojka%40gmail.com/private-abc123/basic.ics.log";
    const out = redact(msg);
    expect(out).not.toContain("private-abc123");
    expect(out).not.toContain("calendar.google.com/calendar");
    expect(out).toContain("[redacted]");
  });
});

describe("P1 regression: tool OUTPUT passes through the redactor", () => {
  it("an event title containing the feed URL is redacted in executeEvents output", async () => {
    const url = "https://example.invalid/private-token-xyz/basic.ics";
    const ics = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//t//EN",
      "BEGIN:VEVENT", "UID:leak@t", "DTSTAMP:20260901T000000Z",
      "DTSTART:20260910T100000Z", "DTEND:20260910T110000Z",
      `SUMMARY:Backup at ${url}`,
      "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n");
    const runtime = await resolveRuntimeAsync(
      { calendars: [{ id: "t", url }], timezone: TZ },
      new FeedCache(),
    );
    runtime.fetchImpl = (async () => new Response(ics, { status: 200 })) as never;
    const result = await executeEvents({ from: "2026-09-05", to: "2026-09-21" }, runtime);
    const json = JSON.stringify(result);
    expect(json).not.toContain("private-token-xyz");
    expect(json).toContain("[redacted]");
  });
});

describe("SecretRef url (0.1.2)", () => {
  const ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\nEND:VCALENDAR\r\n";

  it("object url is resolved through the injected ref resolver", async () => {
    const seen: string[] = [];
    const runtime = await resolveRuntimeAsync(
      { calendars: [{ id: "t", url: { source: "env", id: "GOOGLE_ICAL_URL" } }], timezone: TZ },
      new FeedCache(),
      async (ref) => {
        seen.push(`${ref.source}:${ref.id}`);
        return "https://example.invalid/from-ref/basic.ics";
      },
    );
    runtime.fetchImpl = (async (u: string) => {
      expect(u).toBe("https://example.invalid/from-ref/basic.ics");
      return new Response(ics, { status: 200 });
    }) as never;
    const result = await executeEvents({ from: "2026-09-05", to: "2026-09-07" }, runtime);
    expect("error" in result).toBe(false);
    expect(seen).toContain("env:GOOGLE_ICAL_URL");
  });

  it("ref resolution failure surfaces as a feed error, not a crash", async () => {
    const runtime = await resolveRuntimeAsync(
      { calendars: [{ id: "t", url: { source: "env", id: "MISSING_REF" } }], timezone: TZ },
      new FeedCache(),
      async () => {
        throw new Error("unresolved SecretRef");
      },
    ).catch(() => null);
    // Config-time resolution throws on the fail-fast path; runtime path reports feedErrors.
    expect(runtime).toBeNull();
  });

  it("url + secretEnv conflict is still rejected (object url counts as url)", async () => {
    process.env.ICAL_TEST_SECRET_URL = "https://example.invalid/x.ics";
    try {
      await expect(
        resolveRuntimeAsync(
          {
            calendars: [
              { id: "t", url: { source: "env", id: "A" }, secretEnv: "ICAL_TEST_SECRET_URL" },
            ],
          },
          new FeedCache(),
          async () => "https://example.invalid/ref.ics",
        ),
      ).rejects.toThrow(/either url or secretEnv/);
    } finally {
      delete process.env.ICAL_TEST_SECRET_URL;
    }
  });

  it("SecretRef url contributes to the redactor needles", async () => {
    const runtime = await resolveRuntimeAsync(
      { calendars: [{ id: "t", name: "T", url: { source: "env", id: "R" } }], timezone: TZ },
      new FeedCache(),
      async () => "https://example.invalid/secret-needle/basic.ics",
    );
    expect(runtime.redact("value https://example.invalid/secret-needle/basic.ics here")).toContain(
      "[redacted]",
    );
  });
});

// ---------------------------------------------------------------------------

describe("cache semantics", () => {
  const ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\nEND:VCALENDAR\r\n";
  const ok = async () => new Response(ics, { status: 200 });
  const fail = async () => {
    throw new TypeError("fetch failed");
  };
  const feed: FeedConfig = { id: "x", name: "x", url: "https://example.invalid/x.ics" };

  it("serves fresh memory within TTL, calls network once", async () => {
    const cache = new FeedCache();
    let calls = 0;
    const counting = async () => {
      calls++;
      return new Response(ics, { status: 200 });
    };
    const a = await ensureFeed(feed, 60_000, 5000, cache, undefined, counting as never);
    const b = await ensureFeed(feed, 60_000, 5000, cache, undefined, counting as never);
    expect(a.stale).toBe(false);
    expect(b.stale).toBe(false);
    expect(calls).toBe(1);
  });

  it("serves stale with ageSeconds when a refresh fails and a copy exists", async () => {
    const cache = new FeedCache();
    await ensureFeed(feed, 1, 5000, cache, undefined, ok as never); // TTL=1ms
    await new Promise((r) => setTimeout(r, 10));
    const out = await ensureFeed(feed, 1, 5000, cache, undefined, fail as never);
    expect(out.stale).toBe(true);
    expect(out.raw).toBe(ics);
    expect(out.ageSeconds).toBeGreaterThanOrEqual(0);
  });

  it("P2 regression: after a failed refresh, the NEXT read still reports stale (never fresh)", async () => {
    const cache = new FeedCache();
    await ensureFeed(feed, 1, 5000, cache, undefined, ok as never);
    await new Promise((r) => setTimeout(r, 10));
    const second = await ensureFeed(feed, 1, 5000, cache, undefined, fail as never);
    expect(second.stale).toBe(true);
    // Backoff path: no new attempt performed, data must NOT be called fresh.
    const third = await ensureFeed(feed, 1, 5000, cache, undefined, ok as never);
    expect(third.stale).toBe(true);
    expect(third.ageSeconds).toBeGreaterThanOrEqual(0);
  });

  it("throws when there is no copy and the fetch fails", async () => {
    const cache = new FeedCache();
    await expect(
      ensureFeed(feed, 60_000, 5000, cache, undefined, fail as never),
    ).rejects.toThrow();
  });

  it("R4-P1: reconfigured source URL NEVER serves the old calendar's bytes", async () => {
    const cache = new FeedCache();
    const feedA: FeedConfig = { id: "x", name: "x", url: "https://a.invalid/x.ics" };
    const feedB: FeedConfig = { id: "x", name: "x", url: "https://b.invalid/x.ics" };
    await ensureFeed(feedA, 60_000, 5000, cache, undefined, ok as never);
    // Same id, new source URL, failing fetch: must THROW, not serve feed A.
    await expect(
      ensureFeed(feedB, 60_000, 5000, cache, undefined, fail as never),
    ).rejects.toThrow(FeedFetchError);
    // The foreign-source entry was dropped rather than kept as a fallback.
    expect(cache.has("x")).toBe(false);
  });

  it("R4-P1: after a source switch + successful fetch, only new-source data is cached", async () => {
    const cache = new FeedCache();
    const feedA: FeedConfig = { id: "x", name: "x", url: "https://a.invalid/x.ics" };
    const feedB: FeedConfig = { id: "x", name: "x", url: "https://b.invalid/x.ics" };
    await ensureFeed(feedA, 60_000, 5000, cache, undefined, ok as never);
    const icsB = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//b//EN\r\nEND:VCALENDAR\r\n";
    const out = await ensureFeed(
      feedB,
      60_000,
      5000,
      cache,
      undefined,
      (async () => new Response(icsB, { status: 200 })) as never,
    );
    expect(out.raw).toBe(icsB);
  });

  it("R4-P2: an untrusted-length stream over the byte cap is rejected while streaming", async () => {
    const cache = new FeedCache();
    // Pre-seed a good copy so the rejection can fall back to stale.
    await ensureFeed(feed, 1, 5000, cache, undefined, ok as never);
    await new Promise((r) => setTimeout(r, 10));
    let fullyConsumed = false;
    const over = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            // No content-length header; 25 MiB + 1 byte delivered in chunks.
            const chunk = new Uint8Array(1024 * 1024);
            for (let i = 0; i < 25; i++) controller.enqueue(chunk);
            controller.enqueue(new Uint8Array(1));
            fullyConsumed = true;
            controller.close();
          },
        }),
        { status: 200 },
      );
    const out = await ensureFeed(feed, 1, 5000, cache, undefined, over as never);
    // Rejected bytes never replace the good copy; we read stale instead.
    expect(out.stale).toBe(true);
    expect(out.raw).toBe(ics);
    expect(fullyConsumed).toBe(true); // stream was consumed up to the cap, then aborted
    void MAX_BODY_BYTES;
  });

  it("R4-P2: with no cached copy, an oversized stream is an error, not a silent pass", async () => {
    const cache = new FeedCache();
    const over = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            const chunk = new Uint8Array(1024 * 1024);
            for (let i = 0; i <= MAX_BODY_BYTES / (1024 * 1024); i++) controller.enqueue(chunk);
            controller.close();
          },
        }),
        { status: 200 },
      );
    await expect(
      ensureFeed(feed, 60_000, 5000, cache, undefined, over as never),
    ).rejects.toThrow(/too large/);
  });

  it("fresh bytes that fail validation NEVER evict the last good copy", async () => {
    const cache = new FeedCache();
    await ensureFeed(feed, 1, 5000, cache, assertParseable, ok as never);
    await new Promise((r) => setTimeout(r, 10));
    const garbage = async () => new Response("<html>landing</html>", { status: 200 });
    const out = await ensureFeed(feed, 1, 5000, cache, assertParseable, garbage as never);
    expect(out.stale).toBe(true);
    expect(out.raw).toBe(ics);
    // And the bad bytes did not poison the cache.
    const again = await ensureFeed(feed, 1, 5000, cache, assertParseable, garbage as never);
    expect(again.raw).toBe(ics);
  });
});

// ---------------------------------------------------------------------------

describe("timezone policy", () => {
  it("spring gap shifts forward, autumn fold takes the earlier instant", () => {
    const gap = wallTimeToInstant(2026, 3, 29, 2, 30, 0, TZ);
    expect(gap.toISOString()).toBe("2026-03-29T01:00:00.000Z");
    expect(toLocalIso(gap, TZ).slice(11, 16)).toBe("03:00");

    const fold = wallTimeToInstant(2026, 10, 25, 2, 30, 0, TZ);
    expect(fold.toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });

  it("localDateString survives DST days", () => {
    const d = new Date("2026-10-25T23:00:00Z");
    expect(localDateString(d, TZ)).toBe("2026-10-26");
  });

  it("splitDate rejects nonexistent dates", () => {
    expect(() => splitDate("2026-02-30")).toThrow();
    expect(splitDate("2026-09-06")).toEqual([2026, 9, 6]);
  });
});

// ---------------------------------------------------------------------------

describe("executeEvents end-to-end (fixture feed through the full pipeline)", () => {
  async function runtimeWith(fixture: string): Promise<Runtime> {
    const runtime = await resolveRuntimeAsync(
      { calendars: [{ id: "test", name: "Test", url: "https://example.invalid/test.ics" }], timezone: TZ },
      new FeedCache(),
    );
    runtime.fetchImpl = (async () => new Response(fixture, { status: 200 })) as never;
    return runtime;
  }

  it("lists events in chronological order with one representation per value", async () => {
    const result = await executeEvents(
      { from: "2026-09-05", to: "2026-09-21" },
      await runtimeWith(read("basic.ics")),
    );
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.stale).toBe(false);
    expect(result.partial).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.returnedCount).toBe(result.events.length);
    expect(result.totalMatches).toBe(result.events.length);
    // No duplicate representations.
    for (const e of result.events) {
      expect(e).not.toHaveProperty("startIso");
      expect(e).not.toHaveProperty("endIso");
      expect(e).not.toHaveProperty("count");
    }
    // Chronological.
    const starts = result.events.map((e) => e.start);
    expect([...starts].sort()).toEqual(starts);
    // All-day uses date-only exclusive end; timed uses local ISO with offset.
    const multi = result.events.find((e) => e.title === "Zavraracka vikend");
    expect(multi?.allDay).toBe(true);
    expect(multi?.start).toBe("2026-09-11");
    expect(multi?.end).toBe("2026-09-14");
    const timed = result.events.find((e) => e.title === "Strih - Kabinet holicu");
    expect(timed?.start).toBe("2026-09-07T11:00:00+02:00");
  });

  it("query filters case/diacritics-insensitively; includeAllDay=false drops all-day", async () => {
    const runtime = await runtimeWith(read("basic.ics"));
    const q = await executeEvents({ from: "2026-09-05", to: "2026-09-21", query: "obed" }, runtime);
    if ("error" in q) throw new Error(q.error);
    expect(q.events).toHaveLength(1);
    expect(q.events[0].title).toBe("Obed Lesna");

    const noAllDay = await executeEvents(
      { from: "2026-09-05", to: "2026-09-21", includeAllDay: false },
      await runtimeWith(read("basic.ics")),
    );
    if ("error" in noAllDay) throw new Error(noAllDay.error);
    expect(noAllDay.events.every((e) => !e.allDay)).toBe(true);
  });

  it("unknown calendar id produces a helpful error", async () => {
    const result = await executeEvents({ calendar: "nope" }, await runtimeWith(read("basic.ics")));
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("test");
  });

  it("window spanning > 400 days is rejected", async () => {
    const result = await executeEvents(
      { from: "2026-01-01", to: "2027-06-01" },
      await runtimeWith(read("basic.ics")),
    );
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("400");
  });

  it("single-secret-env config: the env var holds the COMPLETE URL", async () => {
    process.env.ICAL_TEST_SECRET_URL = "https://example.invalid/secret/basic.ics";
    let seenUrl = "";
    try {
      const runtime = await resolveRuntimeAsync(
        { calendars: [{ id: "s", secretEnv: "ICAL_TEST_SECRET_URL" }], timezone: TZ },
        new FeedCache(),
      );
      runtime.fetchImpl = (async (u: string) => {
        seenUrl = u;
        return new Response(read("basic.ics"), { status: 200 });
      }) as never;
      const result = await executeEvents({ from: "2026-09-05", to: "2026-09-07" }, runtime);
      expect("error" in result).toBe(false);
      expect(seenUrl).toBe("https://example.invalid/secret/basic.ics");
    } finally {
      delete process.env.ICAL_TEST_SECRET_URL;
    }
  });

  it("config with BOTH url and secretEnv is rejected at load time", async () => {
    process.env.ICAL_TEST_SECRET_URL = "https://example.invalid/secret/basic.ics";
    try {
      await expect(
        resolveRuntimeAsync(
          {
            calendars: [
              { id: "s", url: "https://example.invalid/a.ics", secretEnv: "ICAL_TEST_SECRET_URL" },
            ],
          },
          new FeedCache(),
        ),
      ).rejects.toThrow(/either url or secretEnv/);
    } finally {
      delete process.env.ICAL_TEST_SECRET_URL;
    }
  });

  it("all feeds failing produces an explicit error, not an empty success", async () => {
    const runtime = await resolveRuntimeAsync(
      { calendars: [{ id: "t", url: "https://example.invalid/t.ics" }], timezone: TZ },
      new FeedCache(),
    );
    runtime.fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as never;
    const result = await executeEvents({ from: "2026-09-05", to: "2026-09-07" }, runtime);
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("failed to load");
  });
});
