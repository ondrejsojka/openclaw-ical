# openclaw-ical — design

Read-only agenda reader over ICS subscription feeds. One tool, `ical_events`.
User-facing setup lives in `README.md`; this file documents internals and the
decisions that survive from the build reviews.

## Architecture (post-simplification, 2026-09-06)

```
┌──────────┐   ┌─────────┐   ┌────────────┐
│ index.ts │──▶│ feed.ts │──▶│calendar.ts │
│ tool I/O │◀──│ fetch+  │   │ parse+     │
│          │   │ cache   │   │ expand     │
└──────────┘   └─────────┘   └────────────┘
```

- **`time.ts`** — Intl-based wall-clock ↔ instant conversion in an explicit
  IANA zone; DST gap shifts forward, fold takes the earlier instant;
  `splitDate` rejects nonexistent dates. Nothing ever resolves in the host
  zone implicitly.
- **`feed.ts`** — URL resolution (`url` XOR `secretEnv`, the env var holds the
  COMPLETE URL), max-25 MB fetch with 30 s timeout (both fixed constants, not
  configurable), in-memory cache with 15 min TTL, refetch backoff via
  `lastAttempt`, source-key guard so a reconfigured id never serves the old
  feed's bytes, and the redactor that strips every URL/path/decoded variant
  ≥ 8 chars from any outbound text.
- **`calendar.ts`** — `assertParseable` (fresh bytes must parse as VCALENDAR
  before they may evict a cached copy), `parseCalendar` (per-feed VTIMEZONE
  registration with snapshot/restore; unregistered TZIDs warn), `expandFeed`
  (window-overlap expansion of singles and RRULE series with EXDATE and
  RECURRENCE-ID overrides — overrides enumerated by *moved* interval so a
  moved-in occurrence whose original sat outside the window still appears).
- **`index.ts`** — config schema, runtime wiring, per-feed fault isolation,
  output shaping.

## Invariants worth keeping

1. **Honest degradation.** `stale` derives from last *successful* fetch, never
   from last attempt (a failed refetch followed by backoff must still report
   `stale: true`). Failed/skip events surface as `partial`, `skippedEvents`,
   `incompleteSeries`, `feedErrors`. Empty output because everything failed is
   an `error`, not an empty success.
2. **Secret containment.** Feed URLs never appear in config when `secretEnv`
   is used, and every outbound string (titles, locations, names, warnings,
   incomplete-series ids) passes through the redactor — an event whose summary
   contains the URL must not leak it (P1 regression test).
3. **RFC 5545 exclusive ends.** All-day events use date-only `start`/`end`;
   `end` is the day after the last covered day.
4. **Recurrence correctness.** Local time holds across DST; EXDATE wins;
   RECURRENCE-ID suppresses the ghost and emits the moved occurrence;
   zero-length events keep `start == end`; negative durations are skipped and
   counted.
5. **One representation per value** in output (no `startIso`/`endIso` twins,
   no `count`/`returnedCount` duplicates).

## Deliberately out of scope (YAGNI ledger)

- Free-slot computation (removed 2026-09-06; the model can reason from the
  event list), availability policies, working-hours config — adds a second
  subsystem for a question the model answers ad hoc.
- Write access, CalDAV, push sync, persistent cache/DB.
- Configurable TTL/timeout knobs — fixed sensible defaults until a caller
  exists.
- Full `RANGE=THISANDFUTURE` restatement (flagged `incompleteSeries` instead).
- Blocking all-day events in any availability reasoning (no such feature).
- IANA tz database dependency (Node's `Intl` already ships it), single-flight
  refresh, hashed cache keys, a query wall-clock budget.

## Review history

Three adversarial review rounds (GPT-5.6-sol, Sep 2026):

1. **Design review** — 5 blockers accepted and designed in (TZID must not
   degrade to floating; half-open intervals; expansion by window overlap; cap
   on queried window; explicit floating/DST policy), 8 rejected (in scope
   ledger above).
2. **Code review** — 15 blockers fixed: override enumeration by moved
   interval, override metadata read from exception components, source-keyed
   cache, refetch backoff, redactor completeness, offsetless-datetime zone,
   zero-length handling, global sort, local-day default window, 400-day cap,
   per-call redaction, `notes[]` instead of overwritten `note`, and more.
3. **Simplification review (accepted & executed)** — removed `ical_free_slots`
   + its busy-policy subsystem; whole-URL-in-one-secret config; fixed TTL and
   timeout; trimmed duplicate output fields; README rewritten for users.
   Two verified bugs fixed: **P1** outbound strings bypassed the redactor,
   **P2** retry backoff mislabelled stale data as fresh.

The simplification round's verdict: architecture fits; publishable after the
above, done here at v0.1.0.
