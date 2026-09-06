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
- Secret-safe: the private feed URL never appears in config, logs or output —
  it is redacted even if an event title happens to contain it.

## Installation

```bash
openclaw plugins install openclaw-ical
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
              "secretEnv": "GOOGLE_ICAL_URL"  // env var holding the COMPLETE URL
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
| `url` | Public feeds with no secret token. |
| `secretEnv` | Private feeds. The named **environment variable holds the entire URL**, so the secret token lives in your secret store, not in plugin config. |

### Google Calendar setup

1. Google Calendar → ⚙ Settings → your calendar → **Integrate calendar**.
2. Copy the **Secret address in iCal format** (treat it like a password —
   anyone with it can read your calendar).
3. Store the whole URL as a secret of kind `env` (paste it on stdin so it
   never lands in shell history):

   ```bash
   openclaw secrets store set GOOGLE_ICAL_URL \
     --kind env \
     --allow-host calendar.google.com \
     --value-file -
   # paste: https://calendar.google.com/calendar/ical/you%40gmail.com/private-XXXX/basic.ics, then Ctrl-D
   ```

   The plugin reads the value from `process.env.GOOGLE_ICAL_URL`, so the
   entry must be `--kind env`; `--allow-host` pins substitution to Google's
   domain only.

4. Wire `secretEnv: "GOOGLE_ICAL_URL"` as above and restart the gateway.

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
npm test            # vitest, 34 tests incl. real-feed regressions
npm run plugin:build
npm run plugin:validate
```

`DESIGN.md` documents the internal design and the adversarial-review history.

## License

MIT
