# BMAsia SYB Monitor

Watches Soundtrack Your Brand (SYB) accounts for unauthorized playlist / schedule / settings changes by customer staff (tablet-level edits), fires alerts to the BMAsia team via Google Chat + Telegram, and optionally auto-reverts to the approved baseline.

The motivating incidents: Citadines (13 zones drift, 07.05.2026), Mercure Danang (06.05.2026), Kahavadi near-cancellation. The pattern is the same — customer staff touches the tablet and undoes BMAsia's design. This service prevents most of it, detects the rest, and (optionally) repairs automatically.

Full architecture + research: see [`docs/DESIGN.md`](docs/DESIGN.md).

## Three layers

| Layer | Mechanism |
|-------|-----------|
| **Prevention** | At onboarding, apply `staffControl=false` per zone + account-level `restrictEditMusic`, `restrictDiscoverMusic`, `restrictBlockTracks`, `restrictUnpairingFromPairedDevices`, `enableActivityLog=true`. |
| **Detection** | Cron worker polls `account.activityLog` every 10 min, writes idempotent `Alert` rows, dispatches Chat + Telegram notifications. |
| **Recovery** | When `autoRevertEnabled` on the account and the new `playFrom` differs from the captured baseline, fire `soundZoneAssignSource` immediately. |

The internal team uses a Next.js dashboard to pick accounts, capture baselines, toggle auto-revert, and triage alerts.

## Stack

- Next.js 15 (App Router) + React 19 + Tailwind v4
- Prisma 6 + Postgres
- Iron-session + scrypt password hashing + email allowlist
- Bearer token (`AGENT_API_TOKEN`) for cron worker + agent integrations
- SYB v2 GraphQL via Basic-token auth

## Local development

```bash
cp .env.example .env
# fill DATABASE_URL (local postgres), SESSION_SECRET (32+ chars), SOUNDTRACK_API_TOKEN

npm install
npx prisma generate
npx prisma db push
npm run dev
# http://localhost:3000
```

### Bootstrap the first user

Set a strong `ADMIN_PASSWORD` in your env, then:

```bash
curl -X POST http://localhost:3000/api/auth/bootstrap \
  -H "X-Bootstrap-Token: $ADMIN_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"email":"norbert@bmasiamusic.com","password":"<strong-password-12+chars>"}'
```

The endpoint refuses if any `User` already exists, so it's safe to leave reachable.

After bootstrap, sign in at `/login`. To add more users — add them to `ALLOWED_EMAILS`, then have them hit `/login` (TODO: self-serve invite flow; for v1 add a User row via `prisma studio`).

### Run the poller manually

```bash
npm run poll:once    # single pass over all monitored accounts
npm run poll         # continuous loop, POLL_LOOP_INTERVAL_SECONDS between passes
```

You can also hit `POST /api/poll` with the bearer token from any scheduler.

## Operator flow

1. **Sign in** at `/login`.
2. **Add account** — `/dashboard` → modal → pick from the live SYB account list.
3. **Open the account** at `/accounts/[id]`:
   - Toggle each zone you want to monitor.
   - **Capture baseline** on each monitored zone. This locks in the current `playFrom` as the approved source. (Or hit "Sync now" first if a zone shows no `lastSeenPlayFrom`.)
   - Toggle **Monitored** on the account.
   - Click **Apply prevention** — this fires `staffControl=false` per monitored zone and the four account-level `restrict*` settings.
   - (Optional) Toggle **Auto-revert** — requires at least one baseline captured.
4. **Watch alerts** at `/alerts`. Each alert offers Ack / Ignore / Revert.

## Deploy

`render.yaml` provisions two services:

- `bmasia-syb-monitor` web service (Next.js)
- `bmasia-syb-monitor-poll` cron service running `npm run poll:once` every 10 min

Set the `sync: false` env vars in the Render dashboard before first deploy:
- `SOUNDTRACK_API_TOKEN`
- `AGENT_API_TOKEN`
- `CHAT_WEBHOOK_URL` (Google Chat incoming-webhook for the BMAsia Music Ops space)
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` (optional fallback)
- `ADMIN_PASSWORD` (used by `/api/auth/bootstrap`)
- `NEXT_PUBLIC_APP_URL` (e.g. `https://bmasia-syb-monitor.onrender.com`)

The Postgres database is auto-provisioned by Render. Prisma migrations apply via `prisma db push` in the build command (v0.1 is happy with that; switch to `prisma migrate deploy` once the schema stabilizes).

## Security notes

- **Email allowlist** (`ALLOWED_EMAILS`) gates UI sign-in. Users must already exist in the `User` table AND be on the allowlist.
- **Bootstrap endpoint** refuses if any user exists. Once bootstrapped, the only path to add a user is via `prisma studio` or a future invite flow.
- **Bearer token** is the cron worker's auth. Keep `AGENT_API_TOKEN` out of logs; rotate by changing the env and redeploying.
- **SYB token scope** — uses an operator-scoped token (same one Nina uses). Power to mutate every monitored account. Don't share beyond this app.
- **No customer-facing surface in v1.** All routes are internal.

## What's NOT in v1 (future work)

- **Per-account alert routing** — the `Account.chatSpaceId` / `telegramChatId` columns are there but routing currently falls back to env defaults. v2 = per-account.
- **Google Workspace SSO** — design doc spec called for it; v1 ships with email+password to match the `bmasia-audio-sharing` template. Upgrade is one file (`src/lib/auth.ts`).
- **LLM judgment layer** — "this drift is a legitimate private event, don't revert." v2.
- **Customer-facing portal** — eventually GMs see their own dashboard.
- **Schedule-aware exceptions** — "during 18:00–22:00 on these dates, allow drift."

## Cross-references

- [`docs/DESIGN.md`](docs/DESIGN.md) — full research + architecture (read this first)
- [`CLAUDE.md`](CLAUDE.md) — project rules for future Claude Code sessions
- `/home/nina/nina-agent/scripts/nina_syb.py` — Python SYB client (`src/lib/syb.ts` is the TS port)
- `/home/bmasia/bmasia-audio-sharing/` — sibling Next.js app, same deploy pattern
