# openclaw-ical

Read-only agenda reader for OpenClaw. One tool — `ical_events` — answers
"what do I have between X and Y" from any ICS subscription feed (Google
Calendar, iCloud, Fastmail, Nextcloud, …).

It is deliberately **not** a scheduling engine: it does not compute free
slots, availability, or write anything back to your calendar. The model can
reason about gaps from the event list itself.

## Features

- Multiple calendars merged into one chronological answer.
- Correct recurrence handling: RRULE expansion, EXDATE, moved instances
  (RECURRENCE-ID), series honouring DST at local time.
- Correct all-day semantics: exclusive end dates per RFC 5545
  (a "3-day retreat" starting Friday ends **Monday**, not Sunday).
- Timezone-safe: TZID, UTC and floating times resolve against your configured
  IANA zone, never the host zone.
- Honest degradation: `stale`, `partial`, `truncated` flags tell the model
  when the answer is incomplete instead of silently omitting events.
- Secret-safe: the private feed URL is resolved through OpenClaw's secrets
  runtime (or env) and redacted everywhere — even if an event title happens
  to contain it.

## Installation

```bash
openclaw plugins install clawhub:openclaw-ical
```

or, from source:

```bash
cd openclaw-ical
npm install
npm run plugin:build
openclaw plugins install .   # path is positional; use --link . for a dev link
```

## Configuration

Add the plugin to `openclaw.json`:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-ical": {
        "enabled": true,
        "config": {
          "timezone": "Europe/Prague",   // optional; default = host zone
          "calendars": [
            {
              "id": "personal",
              "name": "Personal",
              "url": { "source": "env", "id": "GOOGLE_ICAL_URL" }   // SecretRef — preferred
            },
            {
              "id": "team",
              "url": "https://example.com/public/team.ics"           // public feeds may be inline
            }
          ]
        }
      }
    }
  }
}
```

Each calendar takes either `url` **or** `secretEnv` (legacy), never both:

| Form | Use for |
|---|---|
| `url: "https://..."` (string) | Public feeds with no secret token. |
| `url: { source, id, provider? }` (object) | **Private feeds.** An OpenClaw SecretRef resolved by the host secrets runtime at call time — the URL never appears in config. Requires openclaw-ical ≥ 0.1.2. |
| `secretEnv: "NAME"` (string) | Legacy fallback: the plugin reads the complete URL from `process.env.NAME`. Equivalent to a SecretRef, but the env var must be present **in the gateway process itself** — see the gotcha below. |

### Google Calendar setup (SecretRef path, recommended)

1. Google Calendar → ⚙ Settings → your calendar → **Integrate calendar**.
2. Copy the **Secret address in iCal format** (treat it like a password —
   anyone with it can read your calendar).
3. Store the whole URL as an env-kind store entry (paste on stdin so it
   never lands in shell history):

   ```bash
   openclaw secrets store set GOOGLE_ICAL_URL \
     --kind env \
     --value-file -
   # paste: https://calendar.google.com/calendar/ical/you%40gmail.com/private-XXXX/basic.ics, then Ctrl-D
   ```

4. Reference it as a SecretRef: `"url": { "source": "env", "id": "GOOGLE_ICAL_URL" }`.
   The plugin resolves it through `resolveConfiguredSecretInputString` at
   call time — the plugin process never needs the variable in its own
   environment.

### Google Calendar setup (legacy `secretEnv` path — mind the gotcha)

`secretEnv: "GOOGLE_ICAL_URL"` makes the plugin read
`process.env.GOOGLE_ICAL_URL` **inside the gateway process**. A store entry
created with `openclaw secrets store set --kind env` is injected only into
commands the agent executes as *child processes* — it is **not** visible to
the gateway process itself, where plugin code runs. To make the variable
visible to plugins, set it explicitly:

```jsonc
{ "env": { "vars": { "GOOGLE_ICAL_URL": "https://calendar.google.com/.../basic.ics" } } }
```

(or in the systemd unit / shell that starts the gateway), then restart. The
SecretRef path above avoids this entirely — prefer it.

iCloud/Fastmail/Nextcloud: use their public/bearer ICS URLs the same way
(`webcal://` links → change the scheme to `https://`).

## Tool: `ical_events`

| Param | Default | Meaning |
|---|---|---|
| `from` | now | Window start (`YYYY-MM-DD` or ISO datetime). |
| `to` | from + 14 days | Window end, exclusive. Max span 400 days. |
| `calendar` | all | Limit to one calendar `id`. |
| `query` | — | Case/diacritics-insensitive substring on title/location. |
| `includeAllDay` | true | Set false to see only timed events. |
| `limit` | 100 (max 500) | Result cap; `truncated: true` when hit. |

Output markers to trust:

- `stale: true` (+ `staleFeeds[].ageSeconds`) — a refetch failed, you are
  seeing the last good cached copy.
- `partial: true` — a feed failed, events were skipped, or a series hit the
  expansion budget; check `feedErrors` / `skippedEvents` / `incompleteSeries`.
- `allDay: true` events use date-only `start`/`end` where `end` is the day
  **after** the last covered day (RFC 5545).

## Limitations

- Read-only. It will never create, edit, or delete events.
- In-memory cache (15 min TTL). Nothing persists across restarts.
- `RANGE=THISANDFUTURE` restatements are shown only up to the split point and
  the series is flagged in `incompleteSeries` (real-world feeds essentially
  never use restatement).
- One feed over 25 MB or an absurd RRULE count will be capped, never hang.

## Development

```bash
npm install
npm test            # vitest, 42 tests incl. real-feed regressions
npm run plugin:build
npm run plugin:validate
```

`DESIGN.md` documents the internal design and the adversarial-review history.

## License

MIT
