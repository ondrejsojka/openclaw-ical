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
- Secret-safe: private feed URLs can live in a gateway environment variable
  and are redacted everywhere — even if an event title happens to contain one.

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
          "timezone": "Europe/Prague",        // optional; default = host zone
          "calendars": [
            {
              "id": "personal",
              "name": "Personal",
              "secretEnv": "GOOGLE_ICAL_URL"  // env var holding the COMPLETE private URL
            },
            {
              "id": "team",
              "url": "https://example.com/public/team.ics"  // public feeds may be inline
            }
          ]
        }
      }
    }
  }
}
```

Each calendar takes **either** `url` **or** `secretEnv`, never both:

| Field | Use for |
|---|---|
| `url` | Public feeds with no secret token. Must be a URL string. |
| `secretEnv` | Private feeds. The named environment variable holds the complete URL. |

### Google Calendar setup (`secretEnv`)

1. Google Calendar → ⚙ Settings → your calendar → **Integrate calendar**.
2. Copy the **Secret address in iCal format** (treat it like a password —
   anyone with it can read your calendar).
3. Put the complete URL in an environment variable available to the
   **gateway process**, then configure `"secretEnv": "GOOGLE_ICAL_URL"`.

For example, set it through OpenClaw's `env.vars` configuration or in the
systemd/environment configuration that starts the gateway, then restart the
gateway. A secret-store entry alone does not inject the value into an already
running gateway process.

> **Why not a SecretRef object in `url`?** OpenClaw currently passes SecretRef
> objects through unchanged to third-party tool plugins; it does not
> materialize them into strings. Resolving the secrets runtime from plugin code
> also triggers ClawHub's suspicious-package scanner. Until OpenClaw provides
> host-side materialization for tool plugins, private feeds therefore use
> `secretEnv`.

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
npm test            # vitest, 38 tests incl. real-feed regressions
npm run plugin:build
npm run plugin:validate
```

`DESIGN.md` documents the internal design and the adversarial-review history.

## License

MIT
