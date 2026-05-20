# SYB Playlist Monitoring & Auto-Revert App — Research + Design

**Date:** 2026-05-20 16:45 BKK
**Owner:** Nina (research + design); ship target = new Claude Code project
**Brief:** Norbert TG msg 1177 — customer staff change playlists on SYB tablets; build monitoring + alerting + optional auto-revert.

---

## TL;DR

1. **The problem is real and recurring** — Citadines (13 zones drift on 07.05), Mercure Danang (06.05) are documented cases. Customer staff bypass the BMAsia-approved design by touching the tablet.
2. **SYB API exposes everything we need** — verified live: `Account.activityLog` + `SoundZone.activityLog` paginated connections with full Actor/Diff/Action data. PLAY_FROM_CHANGED is a first-class event type.
3. **Prevention beats detection** — `SoundZoneSettings.staffControl: false` is the real lock. The monitoring app's *first* job is to set the lock, not just watch the leak.
4. **Build as a web app + cron worker, not as an agent.** Team needs a config UI + dashboard + alerts. Agent layer plugs in for one-off intelligent triage.
5. **Recommendation: NEW Claude Code project**, scaffolded from the bmasia-audio-sharing pattern. I provide the kickoff prompt + design doc; new instance does the build. Preserves my music-design focus.
6. **Stack: Next.js 15 + Prisma + Postgres on Render** — exactly the BMAsia template. Auth via Google Workspace SSO restricted to bmasiamusic.com.
7. **No real-time webhooks from SYB** — polling-only (5–15 min cadence per zone).

---

## Part 1 — SYB API capabilities (verified live, not assumed)

### What I queried

Used Nina's existing SOUNDTRACK_API_TOKEN against the SYB v2 GraphQL endpoint to introspect the schema, then ran live queries against actual BMAsia accounts (operator role sees 100+ accounts paginated).

### Findings

#### Activity log exists, is per-account-opt-in, paginated

- `Account.activityLog(first, after)` → `ActivityLogConnection`
- `SoundZone.activityLog(first, after)` → `ActivityLogConnection`
- Each `ActivityLogItem` has:
  - `id`, `timestamp` (ISO 8601 UTC)
  - `action: ActivityLogActionType` enum
  - `description: String` (human-readable)
  - `actor: ActivityLogActor` (UNION of `DeviceActor`, `UserActor`, `ActivityLogUserActor`, `InternalActor`)
  - `diff: ActivityLogDiff` (Json or Reference diff with `old`/`new`)
  - `actionData` (action-specific payload)

#### Action types we care about

```
PLAY_FROM_CHANGED        ← the core signal: playlist/schedule swap on a zone
ACCOUNT_SETTING_CHANGED  ← detects if someone disabled activity log itself
DEVICE_PAIRED            ← new tablet/device added
DEVICE_UNPAIRED          ← tablet removed (could indicate disconnect attempt)
TRACK_BLOCKED            ← staff blocking individual songs
TRACK_UNBLOCKED          ← reversal of above
NAME_CHANGED, IMAGE_CHANGED, PHONE_CHANGED, BUSINESS_TYPE_CHANGED, SUBSCRIPTION_*
```

#### Actor attribution — who made the change

The union resolves to one of:
- **`DeviceActor`** — change came from a SYB tablet/device. Includes `device.name`, `device.type`, `device.platform`, `device.osVersion`. This is the *bad case* the customer is complaining about.
- **`UserActor` / `ActivityLogUserActor`** — change came from a logged-in SYB user. Includes `user.name`, `user.email`. This is how we identify which BMAsia/customer person made it.
- **`InternalActor`** — system-initiated (e.g. `"public_api"` for changes made via the GraphQL API, including by us). This is how we'll know "BMAsia made this change" vs "customer staff did."

**Key insight:** The Actor variant alone tells us whether the change came from a tablet (likely customer staff) or a logged-in user (likely BMAsia ops or designated customer admin). This is the alert filter primitive.

#### CRITICAL DEFAULT: `enableActivityLog` is OFF on most accounts

Live data: 50-account sample → only 2 had any activity log entries. Reason: `AccountSettings.enableActivityLog` is `false` by default. **Before monitoring an account, we MUST turn this on** via the `accountUpdate` mutation. Otherwise the activity log is empty no matter what staff do.

#### Prevention primitives (the real moat)

Verified in `AccountSettings` + `SoundZoneSettings`:

| Setting | Scope | Effect |
|---------|-------|--------|
| `SoundZoneSettings.staffControl` | per-zone Boolean | **THE main lever.** When `false`, staff can't change the source from the tablet. |
| `AccountSettings.restrictEditMusic` | account Boolean | Prevents non-admin users from editing playlists/schedules. |
| `AccountSettings.restrictDiscoverMusic` | account Boolean | Prevents browsing/swapping in new music. |
| `AccountSettings.restrictBlockTracks` | account Boolean | Prevents staff blocking individual tracks. |
| `AccountSettings.restrictUnpairingFromPairedDevices` | account Boolean | Prevents tablet unpair attempts. |
| `AccountSettings.enableActivityLog` | account Boolean | Turns on the audit trail (must be on for monitoring). |

**Implication:** A well-locked-down account ALREADY can't be tampered with from the tablet. The monitoring app is really doing two jobs:
1. Apply the prevention layer at onboarding (one-time setup, big customer benefit).
2. Monitor the (now-rare) breakthrough events that get through.

#### Mutations available for recovery

- `soundZoneAssignSource(input)` — re-assign the approved playlist/schedule (the auto-revert)
- `accountUpdate(input)` with `settings: AccountSettingsInput` — reset account-level restrictions if flipped
- `soundZoneUpdateSettings(input)` with `staffControl: false` — re-lock the zone

#### No real-time push — polling only

- The GraphQL `Subscription` type exists but has no `activityLog` field. No webhooks for activity events.
- Polling cadence: 5–15 min per zone is reasonable. Activity entries are immutable + timestamped, so cursor-based pagination via `after` arg is safe.
- For ~100 zones at 10-min cadence = 600 queries/hour. SYB rate limits are generous (no documented limit but we don't want to abuse). Batch by account (one query → many zones).

---

## Part 2 — Architecture recommendation

### Three-layer model

```
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 1: PREVENTION (apply at customer onboarding, big win)     │
│  - Set staffControl=false on monitored zones                     │
│  - Set restrictEditMusic, restrictDiscoverMusic, etc. = true     │
│  - Set enableActivityLog = true                                  │
│  - Record the "approved baseline" (playFrom ID per zone)         │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 2: DETECTION (cron worker, 10-min cadence)                │
│  - Poll account.activityLog since last cursor                    │
│  - Filter for PLAY_FROM_CHANGED, ACCOUNT_SETTING_CHANGED,        │
│    DEVICE_UNPAIRED, settings being weakened                      │
│  - Match diff.new against approved baseline                      │
│  - Fire alert if mismatch AND actor != BMAsia ops                │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 3: RECOVERY (per-account opt-in)                          │
│  - If auto-revert enabled: fire soundZoneAssignSource(baseline)  │
│  - If staffControl was flipped to true: revert via               │
│    soundZoneUpdateSettings                                       │
│  - Log the recovery + notify team in alert                       │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 4: UI / OPS (Next.js web app for team)                    │
│  - Sign in via Google Workspace SSO (bmasiamusic.com only)       │
│  - Pick accounts to monitor (from SYB API account list)          │
│  - View live status: monitored / not, last drift, auto-revert    │
│  - Alert dashboard: chronological, per-account, with diff view   │
│  - Audit log: every change captured + recovery action taken      │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 5: AGENT INTEGRATION (optional, plugs in via API)         │
│  - Webhook to Riff's chat-poster + Telegram for alerts           │
│  - Soundtrack MCP for Lyra/Nina ad-hoc queries                   │
│  - Eventually: an LLM "should we revert?" judgment for nuanced   │
│    cases (e.g. customer flipped during a private event)          │
└─────────────────────────────────────────────────────────────────┘
```

### Why web app, not agent

- **Team-shared UI:** Theo, Nikki, Keith, Scott, Kuk, Riff, Pom all need to see alerts + statuses. Multi-user dashboard is a UI problem.
- **Config persistence:** Approved baseline per zone, auto-revert toggle, alert routing — config that lives, not a chat command.
- **Customer-facing potential v2:** Eventually customers (the better-organized ones) want to see their own dashboard. A web app extends; an agent doesn't.
- **Observability:** Cron worker runs deterministic, can be monitored, restarted, scaled. Agent loops are harder to observe at this granularity.

### Why also an agent layer

- **Triage intelligence:** When 5 alerts fire at once, an agent can group + prioritize + summarize.
- **Ad-hoc queries:** "What changed at Mercure Danang in the last week?" — LLM-Soundtrack-MCP can answer in one breath.
- **Smart auto-revert decisions:** Some drifts are legitimate (customer-led private event). Eventually an LLM judgment layer says "this is benign, don't revert" vs "this is drift, revert."

The agent is a *consumer* of the monitoring app's database + alerts, not the engine itself.

---

## Part 3 — Recommended tech stack (matches BMAsia pattern exactly)

```
Frontend:  Next.js 15 (App Router) + React 19 + Tailwind v4
Backend:   Next.js API routes + Prisma 6
DB:        Postgres on Render (managed)
Auth:      NextAuth.js with Google Workspace provider, domain-restricted to bmasiamusic.com
Polling:   Render cron job (Node) hitting the same Prisma DB
Deploy:    Render web service + Render cron (same render.yaml file)
Alerts:    Webhook out to Riff's chat-poster service + Telegram bot
SYB API:   Shared SOUNDTRACK_API_TOKEN (operator scope), same as Nina uses
```

Reference template: `/home/bmasia/bmasia-audio-sharing/` — clone the structure, replace the domain logic.

### Schema sketch (Prisma)

```prisma
model Account {
  id                  String   @id  // SYB account ID
  businessName        String
  monitored           Boolean  @default(false)
  autoRevertEnabled   Boolean  @default(false)
  alertChannels       Json     // {chat: spaceId, telegram: chatId, email: addr}
  onboardedAt         DateTime?
  preventionApplied   Boolean  @default(false)
  lastPolledAt        DateTime?
  lastCursor          String?  // ActivityLog pagination cursor
  zones               Zone[]
  alerts              Alert[]
}

model Zone {
  id              String  @id  // SYB zone ID
  accountId       String
  name            String
  approvedPlayFrom String?   // The baseline source ID (playlist or schedule)
  approvedPlayFromName String?
  lastSeenPlayFrom String?
  driftDetectedAt DateTime?
  account         Account @relation(fields: [accountId], references: [id])
}

model Alert {
  id          String   @id @default(uuid())
  accountId   String
  zoneId      String?
  syblogId    String   // ActivityLogItem.id, idempotency
  action      String   // PLAY_FROM_CHANGED, etc.
  actorType   String   // DeviceActor / UserActor / InternalActor
  actorName   String?
  actorEmail  String?
  diffOld     Json?
  diffNew     Json?
  timestamp   DateTime
  resolvedAt  DateTime?
  resolution  String?  // auto-reverted, manual, ignored
  account     Account @relation(fields: [accountId], references: [id])
  @@unique([syblogId])
}

model AppliedSetting {
  // Track which prevention settings we've applied so we can detect tamper
  id          String   @id @default(uuid())
  accountId   String
  scope       String   // "account" or "zone:<id>"
  settingName String
  value       String
  appliedAt   DateTime @default(now())
}
```

### Cron polling logic (pseudocode)

```
every 10 min:
  for account in db.account.findMany({monitored: true}):
    result = syb.query(`
      account(id: $id) {
        activityLog(first: 50, after: $cursor) {
          edges { node { ... full fields ... } }
          pageInfo { endCursor hasNextPage }
        }
      }
    `, { id: account.id, cursor: account.lastCursor })

    for entry in result.activityLog.edges:
      if alert.findUnique({ syblogId: entry.id }): continue  // already processed

      if entry.action in ['PLAY_FROM_CHANGED', 'ACCOUNT_SETTING_CHANGED', ...]:
        zone = entry.diff matches a tracked zone
        if entry.actor.type === 'InternalActor' && actor.name === 'public_api':
          // Probably BMAsia-initiated, skip alert
          continue

        alert = db.alert.create({...})
        notify(account.alertChannels, alert)

        if account.autoRevertEnabled && entry.action === 'PLAY_FROM_CHANGED':
          syb.mutate(`soundZoneAssignSource(soundZone: $z, source: $approved)`)
          alert.update({ resolution: 'auto-reverted' })

    db.account.update({ id: account.id, lastCursor: result.pageInfo.endCursor })
```

---

## Part 4 — Build path (recommendation)

### Option A — New Claude Code project (RECOMMENDED)

Norbert spins up a new project at `/home/bmasia/bmasia-syb-guard/` (or similar). Claude Code starts there with a focused context (no music-design history bloat) and builds against this design doc.

**Why I recommend this:**
- Music-design work continues uninterrupted on my side
- Service build gets its own focused engineering context (better decisions)
- Clean repo, clean CLAUDE.md tailored for service-engineering not music-design
- I stay available as the SYB API consultant — new instance can ping me via agent-comms for schema questions, my SYB knowledge transfers cleanly

**Kickoff prompt (paste into fresh Claude Code session):**

```
You're starting a new Next.js service called BMAsia SYB Guard. Its job:
monitor Soundtrack Your Brand (SYB) accounts for unauthorized playlist /
schedule / settings changes by customer staff (tablet-level edits),
fire alerts, and optionally auto-revert to the BMAsia-approved baseline.

Read these in order:
1. /home/nina/nina-agent/data/research/syb-monitoring-app-design-2026-05-20.md
   (the full design doc — research, architecture, schema, polling logic)
2. /home/bmasia/bmasia-audio-sharing/ (reference template for Next.js 15 +
   Prisma + Postgres + Render pattern — clone structure, replace domain)
3. /home/nina/nina-agent/scripts/nina_syb.py (working SYB GraphQL client
   — port to Node, reuse query patterns)

Build target (v1 / 2 weeks):
- Web UI: Google SSO (bmasiamusic.com only), account picker, dashboard,
  alerts table, per-account auto-revert toggle
- Onboarding flow: pick zones, capture approved playFrom baseline,
  apply prevention layer (staffControl=false + restrict* settings +
  enableActivityLog=true) via accountUpdate + soundZoneUpdateSettings
- Cron worker: poll account.activityLog every 10 min per monitored
  account, write to Alert table, fire webhooks
- Alert routing: HTTP POST to Riff's chat-poster service + Telegram bot
- Auto-revert: when enabled per account, fire soundZoneAssignSource
  with the approved baseline if a PLAY_FROM_CHANGED slips through

Stack: Next.js 15, Prisma 6, Postgres on Render, NextAuth.js, iron-session.

Secrets you'll need (from Render env, ask Norbert to set):
- DATABASE_URL (Render auto-provisions)
- SOUNDTRACK_API_TOKEN (shared with Nina, in ai-keys.env)
- GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (Workspace OAuth)
- SESSION_SECRET (Render auto-generates)
- CHAT_POSTER_WEBHOOK_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

Coordinate with Nina (the existing music-designer agent) via
/home/bmasia/agent-comms/send-to-nina.sh when you hit SYB schema
questions — she has live API access + has done the schema introspection.

First milestone: schema + onboarding-flow scaffold + one end-to-end
test against a real BMAsia account (suggest Citadines-FCH — known
drift case from 07.05.2026). Get one alert from end to end before
building the UI polish layer.

Ship to Render as `bmasia-syb-guard`. render.yaml pattern same as
bmasia-audio-sharing.

Start by reading the design doc in full, then ask any clarifying
questions before writing code.
```

### Option B — I (Nina) build it

Possible but not recommended because:
- It'll consume my context heavily during the 1-2 week build
- My music-design responsibilities slow
- Service-engineering context bloat is the exact reason CLAUDE.md hygiene matters
- The work transfers cleanly to a focused new instance via the kickoff prompt above

I'm happy to do it if Norbert prefers single-agent ownership. Just flagging the cost.

---

## Part 5 — Open decisions for Norbert

1. **Project name** — `bmasia-syb-guard` or alternatives? ("guard" reads operational; "sentinel"/"compliance"/"watchdog" are alternatives.)
2. **Scope of v1: how many accounts?** Start with ~5–10 known-drift accounts (Citadines, Mercure Danang, Kahavadi if applicable) before fleet rollout?
3. **Auto-revert default** — should new accounts default to auto-revert ON (with explicit team opt-out) or OFF (explicit opt-in)? My instinct: OFF for v1; team reviews each case and toggles on after building trust.
4. **Alert routing destination** — single Chat space ("BMAsia Music Ops") or per-account-segregated? Single is simpler v1.
5. **Customer-facing v2?** Eventually a customer portal where the customer's own GM sees the same dashboard for their property? Big strategic positioning move ("we don't just play music, we watch it"), but adds multi-tenant complexity. Defer to v2.
6. **Revert policy** — when auto-revert fires, do we also re-lock `staffControl=false` if it got flipped? Probably yes.
7. **Prevention-layer rollout** — apply to ALL active BMAsia SYB accounts (~100+) in a one-time pass, or only to opted-in monitored accounts? My instinct: prevention layer = OPT-IN per account (matches "monitored" flag). Customer-aware rollout otherwise.

---

## Part 6 — Risks / known unknowns

1. **`InternalActor.name == "public_api"` is generic** — when we (BMAsia ops) make a change via the API, the actor is `public_api`. We need a convention to distinguish "BMAsia made this" from "customer or 3rd party made this via their own API token." Possible solution: include a custom client ID in our queries via headers, OR check that the activity log entry's timestamp matches a recent BMAsia-initiated change in our own DB.
2. **Polling rate-limits** — SYB doesn't publish exact rate limits. At 10-min cadence × 100 accounts = 14k queries/day. Almost certainly fine, but worth a soft check.
3. **`enableActivityLog` toggling** — if a customer (or their own admin) disables activity log themselves, we lose visibility AND we lose the audit. Alert on `ACCOUNT_SETTING_CHANGED` for that specific setting → priority alert.
4. **Multi-account SYB users** — some customers (Hilton APAC) have one SYB user account that manages many properties. Activity attribution by user email is still valid, but worth modeling.
5. **Customer-initiated legitimate changes** — sometimes customers WILL change the playlist on purpose (private event, seasonal switch). Auto-revert without judgment will be hostile. v1: human-in-the-loop alert review by default. v2: LLM judgment + scheduled exceptions ("during 18:00-22:00 on dates X, allow drift").
6. **Schedule vs Playlist** — `playFrom` can be either a Playlist or a Schedule. The diff might show Schedule swap not just Playlist. Same monitoring logic works, but the UI should show the type for clarity.

---

## Part 7 — What I'm shipping today

1. ✅ This design doc — research + architecture + kickoff prompt
2. (Pending Norbert greenlight) Either:
   - Send the kickoff prompt into a new Claude Code session (Option A)
   - Start building the scaffold myself in `/home/bmasia/bmasia-syb-guard/` (Option B)

I'll TG Norbert a short summary + ask which path he wants.

---

## Appendix — Schema introspection queries used

For reference / reproducibility, these are the live introspection queries I ran:

```graphql
# Action types
{ __type(name: "ActivityLogActionType") { enumValues { name } } }

# Where activityLog appears
{ __type(name: "Query") { fields { name } } }
{ __type(name: "Account") { fields { name } } }
{ __type(name: "SoundZone") { fields { name } } }

# Item structure
{ __type(name: "ActivityLogItem") { fields { name type { name } } } }

# Actor variants
{ __type(name: "ActivityLogActorEntity") { possibleTypes { name } } }

# Settings primitives
{ __type(name: "AccountSettings") { fields { name } } }
{ __type(name: "SoundZoneSettings") { fields { name } } }

# Live query against a real account
query($id: ID!) {
  account(id: $id) {
    activityLog(first: 10) {
      total
      edges {
        node {
          timestamp action description
          actor { entity { __typename ... on DeviceActor { device { name platform } } } }
          diff { type diffEntity { ... on ActivityLogJSONDiff { old new } } }
        }
      }
    }
  }
}
```

All queries succeed against the BMAsia operator-scoped token. No new SYB API access needed for the build.
