# BMAsia SYB Monitor

Service that monitors Soundtrack Your Brand (SYB) accounts for unauthorized playlist / schedule / settings changes by customer staff (tablet-level edits), fires alerts, and optionally auto-reverts to the BMAsia-approved baseline.

## Role of this project

- **Prevention layer:** apply `staffControl=false`, `restrictEditMusic`, `restrictDiscoverMusic`, `restrictBlockTracks`, `restrictUnpairingFromPairedDevices`, `enableActivityLog` on opted-in accounts.
- **Detection layer:** cron worker polls `account.activityLog` every 10 min, filters for `PLAY_FROM_CHANGED` / `ACCOUNT_SETTING_CHANGED` / `DEVICE_UNPAIRED` / `TRACK_BLOCKED`, and writes idempotent Alert rows.
- **Recovery layer:** if `account.autoRevertEnabled`, fire `setPlayFrom` to restore the approved baseline (then re-read `playFrom` to confirm it took).
- **State check:** every tick, after the activity logs, compare each monitored zone's live `playFrom` with its baseline and revert drift the log missed (outage, missed tick, failed revert). Leaves a source alone when the zone's newest change was by an API client (`public_api`), same as the log path.
- **UI:** Next.js dashboard for the BMAsia team — pick accounts, capture baselines, view alerts, toggle auto-revert.

Full design: `docs/DESIGN.md`.

## Stack

- Next.js 15 App Router + React 19 + Tailwind v4
- Prisma 6 + Postgres (Render-managed)
- Iron-session auth + email allowlist + bearer token for cron worker (matches `bmasia-audio-sharing` pattern; Google SSO is a v2 upgrade path)
- SYB GraphQL v2 client (TS port of `nina_syb.py`)

## Layout

```
src/
  app/                  # Next.js App Router pages + API routes
    (auth)/login        # email/password login
    dashboard           # accounts list + monitored status
    accounts/[id]       # onboarding flow, zone baseline picker, settings toggles
    alerts              # chronological alert list + diff view
    api/
      auth/login        # POST { email, password }
      auth/logout       # POST
      accounts          # GET (list from SYB), POST (onboard)
      accounts/[id]     # GET / PATCH
      accounts/[id]/zones        # GET / POST baseline + prevention
      accounts/[id]/sync         # POST — manual poll for this account
      alerts            # GET (list)
      alerts/[id]/resolve        # POST
      revert            # POST { zoneId } — manual re-assign baseline
  lib/
    prisma.ts           # singleton
    auth.ts             # session + bearer token guards
    syb.ts              # GraphQL client
    syb-queries.ts      # named queries / mutations
    notify.ts           # Chat webhook + Telegram alert routing
    baseline.ts         # capture + compare approved playFrom
    prevention.ts       # apply lockdown settings
    poll-core.ts        # poll-one-account logic (shared by cron + manual-sync)
    utils.ts
  components/           # Server + client UI components

prisma/
  schema.prisma

scripts/
  poll.ts               # cron entry point (--once for single-shot, default = loop)

docs/
  DESIGN.md             # full research + architecture spec
```

## Hard rules

- **Reads broad, writes narrow.** Every SYB mutation (`accountUpdate`, `soundZoneUpdateSettings`, `soundZoneAssignSource`) is gated by an explicit `account.monitored` + `account.preventionApplied` + (for revert) `account.autoRevertEnabled` flag. Nothing fires against an account that wasn't explicitly opted in via the dashboard.
- **Idempotent alert writes.** `Alert.syblogId` is the unique key against the SYB `ActivityLogItem.id`. Re-runs of the poller never double-write.
- **Cursor pagination, not time-based.** Each account stores `lastCursor`; the poller asks for entries `after` that cursor. Resilient to clock skew.
- **Self-action filter.** When this app makes a change (auto-revert), the resulting `ActivityLogItem.actor` will be an `InternalActor` with `name = "public_api"`. Filter those out of alerts to avoid loops.
- **Domain-restricted auth.** Email allowlist (`ALLOWED_EMAILS` env var) gates UI access. Bearer token (`AGENT_API_TOKEN`) gates the cron worker + agent integrations.
- **No customer-facing surface in v1.** This app is internal-team-only.

## Adding a new monitored account (operator flow)

1. Sign in at `/login`.
2. `/dashboard` → "Add account" → pick from the SYB account list.
3. `/accounts/[id]` shows all zones. For each zone you want to lock:
   - Confirm/set the **approved baseline** (current `playFrom`, or pick a different playlist/schedule).
   - Flip **monitored** on.
4. Click **Apply prevention** — sets `staffControl=false` on selected zones, plus account-level restricts + `enableActivityLog=true`.
5. (Optional) Toggle **Auto-revert** on the account if you want the poller to immediately restore the baseline when drift is detected.

## Polling

Cron job runs `npm run poll:once` every 10 min (Render cron). For local dev: `npm run poll` runs a continuous loop with `POLL_LOOP_INTERVAL_SECONDS` between passes.

- `Account.lastPolledAt` = last tick where every SYB read succeeded. If reads keep failing for `POLL_FAILURE_ALERT_MINUTES` (default 20), the poller opens a `POLL_FAILED` alert, sends one ops message (Chat + Telegram) per outage plus a daily reminder, and `poll:once` exits 1 so Render shows the run as failed. It resolves itself on recovery.
- Activity-log entries older than `POLL_STALE_EVENT_MINUTES` (default 30) are stored as `backfilled` and not acted on; the state check fixes the zone's current source instead.
- Alert actions written by the app itself: `PLAY_FROM_DRIFT` (state check) and `POLL_FAILED`.
- SYB enforces GraphQL's field-merge rule: aliases on the `diffEntity` `old`/`new` fields in `syb-queries.ts` are required (see the comment there). Removing them breaks every activity-log read.

## Local dev

```bash
cp .env.example .env
# fill in DATABASE_URL (local postgres), SESSION_SECRET, SOUNDTRACK_API_TOKEN
npm install
npx prisma generate
npx prisma db push
npm run dev
```

Bootstrap admin user: hit `POST /api/auth/bootstrap` once with `{ "email": "...", "password": "..." }` headers `X-Bootstrap-Token: $ADMIN_PASSWORD` — creates the first row.

## Deploy

Render auto-deploys from `render.yaml`. Set the `sync: false` env vars in the Render dashboard:
- `SOUNDTRACK_API_TOKEN`, `AGENT_API_TOKEN`, `CHAT_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ADMIN_PASSWORD`, `NEXT_PUBLIC_APP_URL`.

## Cross-references

- `docs/DESIGN.md` — full architecture spec (read this first)
- `/home/nina/nina-agent/scripts/nina_syb.py` — Python SYB client (the TS port lives at `src/lib/syb.ts`)
- `/home/bmasia/bmasia-audio-sharing/` — sibling Next.js app, same stack/deploy pattern
