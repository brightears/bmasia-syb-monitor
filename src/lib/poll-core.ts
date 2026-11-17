/**
 * Poll one account: read the activity logs, write Alert rows idempotently,
 * dispatch notifications, optionally auto-revert. Then run a state check that
 * compares every monitored zone's live source with its baseline, so drift the
 * activity log missed (or a revert that didn't take) still gets fixed.
 */

import { prisma } from "./prisma";
import {
  fetchActivityLogPage,
  fetchSoundZoneActivityLogPage,
  getAccountWithZones,
  type SybActivityLogEntry,
} from "./syb-queries";
import { revertToBaseline } from "./baseline";
import { dispatchAlert, dispatchOpsMessage } from "./notify";

/** Actions we treat as alert-worthy. Other actions still get cursor-advanced through. */
const ALERTWORTHY = new Set([
  "PLAY_FROM_CHANGED",
  "ACCOUNT_SETTING_CHANGED",
  "DEVICE_UNPAIRED",
  "DEVICE_PAIRED",
  "TRACK_BLOCKED",
  "SOUND_ZONE_SETTING_CHANGED",
]);

/**
 * Activity-log entries older than this are recorded but not acted on (no revert,
 * no notification). They only show up after a gap in polling, e.g. the backlog
 * after an outage. Reverting or alerting on week-old changes would be noise; the
 * state check decides what the zone needs *now*.
 */
function staleEventMs(): number {
  return parseInt(process.env.POLL_STALE_EVENT_MINUTES ?? "30", 10) * 60_000;
}

/**
 * Raise a POLL_FAILED alert (and fail the cron run) once an account's activity
 * log has been unreadable for this long. Covers two missed ticks, so a single
 * SYB hiccup stays quiet.
 */
function pollFailureAlertMs(): number {
  return parseInt(process.env.POLL_FAILURE_ALERT_MINUTES ?? "20", 10) * 60_000;
}

const DAY_MS = 24 * 60 * 60_000;

function isInternalApiActor(entry: SybActivityLogEntry): boolean {
  const a = entry.actor;
  if (!a) return false;
  if (a.__typename !== "InternalActor") return false;
  return a.name === "public_api" || a.name === "system";
}

function severityFor(action: string, actorType: string | undefined): string {
  if (action === "ACCOUNT_SETTING_CHANGED") return "critical"; // someone may have disabled activity log
  if (action === "DEVICE_UNPAIRED") return "critical";
  if (action === "PLAY_FROM_CHANGED" && actorType === "DeviceActor") return "warn";
  if (action === "PLAY_FROM_CHANGED") return "warn";
  if (action === "TRACK_BLOCKED") return "info";
  return "info";
}

function describeRefSide(side: unknown): { id?: string; name?: string; kind?: string } {
  if (!side || typeof side !== "object") return {};
  const s = side as Record<string, unknown>;
  const kind = typeof s.__typename === "string" ? s.__typename : undefined;
  // SYB references nest the entity one level deep: PlaylistReference.playlist,
  // ScheduleReference.schedule, etc. Pick whichever inner object exists.
  const inner =
    (s.playlist as Record<string, unknown> | undefined) ??
    (s.schedule as Record<string, unknown> | undefined) ??
    (s.track as Record<string, unknown> | undefined) ??
    (s.device as Record<string, unknown> | undefined) ??
    s;
  return {
    id: typeof inner?.id === "string" ? inner.id : undefined,
    name: typeof inner?.name === "string" ? inner.name : undefined,
    kind,
  };
}

function diffPair(entry: SybActivityLogEntry): { old: unknown; new: unknown } {
  const d = entry.diff;
  if (!d) return { old: null, new: null };
  if (d.type === "reference") {
    return { old: describeRefSide(d.old), new: describeRefSide(d.new) };
  }
  return { old: d.old ?? null, new: d.new ?? null };
}

function attemptResolveZoneId(
  entry: SybActivityLogEntry,
  knownZoneIds: Set<string>
): string | null {
  // Used only by the account-level poll (which surfaces ACCOUNT_SETTING_CHANGED
  // and similar) where the zone is not implicit. For zone-level entries we
  // already know the zone.
  const payload = JSON.stringify(entry);
  for (const zid of knownZoneIds) {
    if (payload.includes(zid)) return zid;
  }
  return null;
}

export interface PollResult {
  accountId: string;
  fetched: number;
  alertsCreated: number;
  /** Reverts that took, from the activity log or the state check. */
  autoReverted: number;
  /** Zones the state check found off baseline and put back. */
  stateCheckReverted: number;
  /** Failed SYB reads this tick (activity logs, live zone state). */
  readErrors: string[];
  /** Everything else that went wrong: notifications, reverts. */
  notificationErrors: string[];
  /**
   * True when SYB has been unreadable for longer than POLL_FAILURE_ALERT_MINUTES
   * (or the poll crashed). The cron entry point exits non-zero on this.
   */
  unhealthy: boolean;
  /** Set when this tick opened a new POLL_FAILED alert (for the ops summary). */
  newPollFailure: { businessName: string; lastGoodPoll: Date | null; error: string } | null;
  cursorAdvanced: boolean;
  endCursor: string | null;
}

type AccountRow = Awaited<ReturnType<typeof loadAccount>>;

function loadAccount(accountId: string) {
  return prisma.account.findUniqueOrThrow({
    where: { id: accountId },
    include: { zones: true },
  });
}

export async function pollOneAccount(accountId: string): Promise<PollResult> {
  const account = await loadAccount(accountId);

  if (!account.monitored) {
    throw new Error(`Account ${accountId} is not monitored — skipping.`);
  }

  const pageSize = parseInt(process.env.POLL_PAGE_SIZE ?? "50", 10);
  const monitoredZones = account.zones.filter((z) => z.monitored);
  const knownZoneIds = new Set(account.zones.map((z) => z.id));

  const result: PollResult = {
    accountId,
    fetched: 0,
    alertsCreated: 0,
    autoReverted: 0,
    stateCheckReverted: 0,
    readErrors: [],
    notificationErrors: [],
    unhealthy: false,
    newPollFailure: null,
    cursorAdvanced: false,
    endCursor: null,
  };

  // Newest PLAY_FROM_CHANGED seen per zone this tick — the state check uses it to
  // leave alone a source that an API client (us, or another BMAsia tool) set.
  const latestPlayFromChange = new Map<string, SybActivityLogEntry>();
  // Zones the activity-log path already tried (and failed) to revert this tick.
  const revertFailedThisTick = new Set<string>();

  // Process the per-zone activityLog for every monitored zone. Account-level
  // activityLog is polled separately below for ACCOUNT_SETTING_CHANGED.
  //
  // Strategy: ALWAYS fetch the newest N entries with NO `after` cursor.
  // The previous cursor-based pagination paged BACKWARD into history (SYB's
  // newest-first connection means `after: cursor` returns OLDER items, not
  // newer ones), so after the first-run anchor every subsequent poll fetched
  // 0 entries and missed all real drift. Dedup is done via `Alert.syblogId`
  // unique index — already enforced by processEntry's `findUnique` short-
  // circuit. `lastCursor` is repurposed as a first-run marker only (non-null
  // == "we've done the anchor, start alerting").
  for (const zone of monitoredZones) {
    const isFirstRun = zone.lastCursor === null;
    const fetchSize = isFirstRun ? 1 : pageSize;

    let zonePage;
    try {
      zonePage = await fetchSoundZoneActivityLogPage(zone.id, {
        first: fetchSize,
        after: null,
      });
    } catch (e) {
      result.readErrors.push(`zone log ${zone.name}: ${(e as Error).message}`);
      continue;
    }

    result.fetched += zonePage.entries.length;

    for (const entry of zonePage.entries) {
      if (entry.action !== "PLAY_FROM_CHANGED") continue;
      const prev = latestPlayFromChange.get(zone.id);
      if (!prev || entry.timestamp > prev.timestamp) latestPlayFromChange.set(zone.id, entry);
    }

    if (isFirstRun) {
      // Anchor: any non-null value flips us out of first-run state on the
      // next tick. We keep storing endCursor for forensic visibility.
      await prisma.zone.update({
        where: { id: zone.id },
        data: {
          lastCursor: zonePage.endCursor ?? "anchored",
          lastPolledAt: new Date(),
        },
      });
      if (zonePage.endCursor) result.cursorAdvanced = true;
      continue;
    }

    // SYB returns entries newest-first; process oldest-first to preserve causality.
    // processEntry idempotency (Alert.syblogId unique) makes re-fetching
    // already-seen entries every tick safe.
    const entries = [...zonePage.entries].sort((a, b) =>
      a.timestamp.localeCompare(b.timestamp)
    );

    for (const entry of entries) {
      const handled = await processEntry(
        entry,
        account,
        zone.id,
        new Map([[zone.id, zone]])
      );
      if (handled.alertCreated) result.alertsCreated += 1;
      if (handled.autoReverted) result.autoReverted += 1;
      if (handled.revertFailed) revertFailedThisTick.add(zone.id);
      if (handled.error) result.notificationErrors.push(handled.error);
    }

    await prisma.zone.update({
      where: { id: zone.id },
      data: { lastPolledAt: new Date() },
    });
  }

  // Also poll the account-level activityLog for account-scoped events
  // (ACCOUNT_SETTING_CHANGED — e.g., someone disabling enableActivityLog).
  // PLAY_FROM_CHANGED is filtered out below since the per-zone loop handles it.
  // Same fix as per-zone: fetch newest N with no cursor, dedup via Alert.syblogId.
  await pollAccountLog(account, pageSize, knownZoneIds, monitoredZones, result);

  // Desired-state check: independent of the activity log, so it still protects
  // zones when the log query breaks, a tick is missed, or a revert didn't take.
  await stateCheck(account, latestPlayFromChange, revertFailedThisTick, result);

  await recordPollHealth(account, result);

  return result;
}

async function pollAccountLog(
  account: AccountRow,
  pageSize: number,
  knownZoneIds: Set<string>,
  monitoredZones: AccountRow["zones"],
  result: PollResult
): Promise<void> {
  const acctIsFirstRun = account.lastCursor === null;

  let acctPage;
  try {
    acctPage = await fetchActivityLogPage(account.id, {
      first: acctIsFirstRun ? 1 : pageSize,
      after: null,
    });
  } catch (e) {
    result.readErrors.push(`account log: ${(e as Error).message}`);
    return;
  }

  result.fetched += acctPage.entries.length;

  if (acctIsFirstRun) {
    // Anchor: any non-null value flips us out of first-run on the next tick.
    await prisma.account.update({
      where: { id: account.id },
      data: { lastCursor: acctPage.endCursor ?? "anchored" },
    });
    if (acctPage.endCursor) {
      result.cursorAdvanced = true;
      result.endCursor = acctPage.endCursor;
    }
    return;
  }

  const acctEntries = [...acctPage.entries].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp)
  );

  const monitoredZoneById = new Map(monitoredZones.map((z) => [z.id, z]));

  for (const entry of acctEntries) {
    // Skip drift events — the per-zone loop above handles them with full fidelity.
    if (entry.action === "PLAY_FROM_CHANGED") continue;

    const zoneId = attemptResolveZoneId(entry, knownZoneIds);
    const handled = await processEntry(entry, account, zoneId, monitoredZoneById);
    if (handled.alertCreated) result.alertsCreated += 1;
    if (handled.autoReverted) result.autoReverted += 1;
    if (handled.error) result.notificationErrors.push(handled.error);
  }
}

interface ProcessEntryResult {
  alertCreated: boolean;
  autoReverted: boolean;
  revertFailed: boolean;
  error: string | null;
}

type AccountForAlerts = {
  id: string;
  businessName: string;
  autoRevertEnabled: boolean;
  chatSpaceId: string | null;
  telegramChatId: string | null;
};

type ZoneForAlerts = {
  id: string;
  name: string;
  approvedPlayFromId: string | null;
  approvedPlayFromName: string | null;
};

async function processEntry(
  entry: SybActivityLogEntry,
  account: AccountForAlerts,
  zoneId: string | null,
  monitoredZoneById: Map<string, ZoneForAlerts>
): Promise<ProcessEntryResult> {
  const result: ProcessEntryResult = {
    alertCreated: false,
    autoReverted: false,
    revertFailed: false,
    error: null,
  };

  // Idempotency
  const dup = await prisma.alert.findUnique({ where: { syblogId: entry.id } });
  if (dup) return result;
  if (!ALERTWORTHY.has(entry.action)) return result;
  if (isInternalApiActor(entry)) return result;

  const monitoredZone = zoneId ? monitoredZoneById.get(zoneId) ?? null : null;

  // Only alert on PLAY_FROM_CHANGED for monitored zones.
  if (entry.action === "PLAY_FROM_CHANGED" && !monitoredZone) return result;

  const diff = diffPair(entry);
  const actorType = entry.actor?.__typename ?? "Unknown";
  const actorName =
    entry.actor?.device?.name ??
    entry.actor?.user?.name ??
    entry.actor?.name ??
    null;
  const actorEmail = entry.actor?.user?.email ?? null;

  // Backlog from a polling gap: keep the record, don't act on it.
  const isStale = Date.now() - new Date(entry.timestamp).getTime() > staleEventMs();

  const alert = await prisma.alert.create({
    data: {
      syblogId: entry.id,
      accountId: account.id,
      zoneId: zoneId ?? null,
      action: entry.action,
      description: entry.description ?? null,
      actorType,
      actorName,
      actorEmail,
      actorRaw: (entry.actor as object | undefined) ?? undefined,
      diffOld: (diff.old as object | null) ?? undefined,
      diffNew: (diff.new as object | null) ?? undefined,
      timestamp: new Date(entry.timestamp),
      severity: severityFor(entry.action, actorType),
      ...(isStale
        ? {
            resolution: "backfilled",
            resolutionNote:
              "Found after a gap in polling; recorded without reverting or notifying. " +
              "The state check handles the zone's current source.",
            resolvedAt: new Date(),
            resolvedBy: "cron",
          }
        : {}),
    },
  });
  result.alertCreated = true;
  if (isStale) return result;

  let resolution: string | null = null;
  // Whether this alert is genuinely handled (drift undone / already on baseline).
  // A FAILED auto-revert is not — it stays open and still notifies the team.
  let resolvedNow = false;
  if (
    entry.action === "PLAY_FROM_CHANGED" &&
    account.autoRevertEnabled &&
    monitoredZone?.approvedPlayFromId
  ) {
    const newRef = diff.new as { id?: string } | null;
    if (newRef?.id && newRef.id !== monitoredZone.approvedPlayFromId) {
      try {
        const rev = await revertToBaseline(monitoredZone.id);
        if (rev.reverted) {
          resolution = "auto-reverted";
          resolvedNow = true;
          result.autoReverted = true;
        } else {
          // Mutation returned OK but the zone didn't switch (the SONOS silent
          // no-op we used to record as success). Leave the alert OPEN and notify.
          resolution = "auto-revert-failed";
          result.revertFailed = true;
          result.error =
            `auto-revert ${monitoredZone.id}: didn't take — still on ` +
            `"${rev.observedPlayFromName ?? "another source"}"`;
        }
      } catch (e) {
        result.revertFailed = true;
        result.error = `auto-revert ${monitoredZone.id}: ${(e as Error).message}`;
      }
    } else if (newRef?.id === monitoredZone.approvedPlayFromId) {
      resolution = "ignored:matches-baseline";
      resolvedNow = true;
    }
  }

  if (resolution) {
    await prisma.alert.update({
      where: { id: alert.id },
      // Only stamp resolvedAt/resolvedBy when actually handled; a failed
      // auto-revert records the attempt but keeps the alert open.
      data: {
        resolution,
        ...(resolvedNow ? { resolvedAt: new Date(), resolvedBy: "cron" } : {}),
      },
    });
  }

  // Stay quiet only when we actually handled it; a failed revert must notify.
  const skipChat = resolvedNow;

  if (!skipChat) {
    const err = await notify(account, monitoredZone, alert.id);
    if (err) result.error = (result.error ? result.error + "; " : "") + err;
  }

  if (zoneId && entry.action === "PLAY_FROM_CHANGED") {
    await prisma.zone.update({
      where: { id: zoneId },
      data: {
        driftDetectedAt: new Date(entry.timestamp),
        lastSeenPlayFromId: (diff.new as { id?: string } | null)?.id ?? null,
        lastSeenPlayFromName:
          (diff.new as { name?: string } | null)?.name ?? null,
      },
    });
  }

  return result;
}

async function notify(
  account: AccountForAlerts,
  zone: ZoneForAlerts | null,
  alertId: string
): Promise<string | null> {
  const fresh = await prisma.alert.findUniqueOrThrow({ where: { id: alertId } });
  const dispatch = await dispatchAlert({
    account: {
      id: account.id,
      businessName: account.businessName,
      chatSpaceId: account.chatSpaceId,
      telegramChatId: account.telegramChatId,
    },
    zone: zone
      ? { id: zone.id, name: zone.name, approvedPlayFromName: zone.approvedPlayFromName }
      : null,
    alert: fresh,
    appBaseUrl: process.env.NEXT_PUBLIC_APP_URL,
  });
  return dispatch.errors.length ? dispatch.errors.join("; ") : null;
}

/**
 * Compare each monitored zone's live source with its approved baseline and put
 * drifted zones back. Same gates as the activity-log revert: account opted into
 * auto-revert, zone monitored, baseline captured.
 *
 * Leaves a zone alone when its newest PLAY_FROM_CHANGED (read this tick) was made
 * by an API client and set exactly what's playing now — the activity-log path
 * ignores those changes too (our own reverts, other BMAsia tools).
 *
 * A revert that takes is recorded as a resolved PLAY_FROM_DRIFT alert, quietly.
 * One that fails opens a PLAY_FROM_DRIFT alert and notifies once per drift
 * episode; it's retried every tick until it takes.
 */
async function stateCheck(
  account: AccountRow,
  latestPlayFromChange: Map<string, SybActivityLogEntry>,
  revertFailedThisTick: Set<string>,
  result: PollResult
): Promise<void> {
  if (!account.autoRevertEnabled) return;

  const candidateIds = account.zones
    .filter((z) => z.monitored && z.approvedPlayFromId && !revertFailedThisTick.has(z.id))
    .map((z) => z.id);
  if (candidateIds.length === 0) return;

  let remote;
  try {
    remote = await getAccountWithZones(account.id);
  } catch (e) {
    result.readErrors.push(`zone state: ${(e as Error).message}`);
    return;
  }
  if (!remote) {
    result.readErrors.push("zone state: SYB returned no account");
    return;
  }
  const liveById = new Map(remote.zones.map((z) => [z.id, z]));

  // Re-read: the activity-log pass may have reverted zones or set drift flags.
  const zones = await prisma.zone.findMany({ where: { id: { in: candidateIds } } });

  for (const zone of zones) {
    const baselineId = zone.approvedPlayFromId!;
    const live = liveById.get(zone.id);
    if (!live) continue; // zone no longer in SYB — not ours to touch

    const liveId = live.playFrom?.id ?? null;
    const liveName = live.playFrom?.name ?? null;

    if (liveId === baselineId) {
      if (zone.driftDetectedAt) {
        await prisma.zone.update({
          where: { id: zone.id },
          data: { driftDetectedAt: null, lastSeenPlayFromId: liveId, lastSeenPlayFromName: liveName },
        });
      }
      // Someone (or something) put it back: close open state-check alerts.
      await prisma.alert.updateMany({
        where: { zoneId: zone.id, action: "PLAY_FROM_DRIFT", resolvedAt: null },
        data: { resolution: "back-on-baseline", resolvedAt: new Date(), resolvedBy: "cron" },
      });
      continue;
    }

    const last = latestPlayFromChange.get(zone.id);
    if (last && isInternalApiActor(last)) {
      const setTo = describeRefSide(last.diff?.new).id ?? null;
      if (setTo && setTo === liveId) continue;
    }

    const now = new Date();
    const episodeStart = zone.driftDetectedAt ?? now;
    const offBaseline = { id: liveId, name: liveName, kind: live.playFrom?.__typename ?? null };
    const baseline = { id: baselineId, name: zone.approvedPlayFromName };

    let reverted = false;
    let failure = "";
    try {
      const rev = await revertToBaseline(zone.id);
      reverted = rev.reverted;
      if (!reverted) failure = `didn't take — still on "${rev.observedPlayFromName ?? "another source"}"`;
    } catch (e) {
      failure = (e as Error).message;
    }

    if (reverted) {
      result.stateCheckReverted += 1;
      result.autoReverted += 1;
      await prisma.alert.create({
        data: {
          syblogId: `state-check:${zone.id}:${now.toISOString()}`,
          accountId: account.id,
          zoneId: zone.id,
          action: "PLAY_FROM_DRIFT",
          description: "Zone was off its baseline; the state check put it back.",
          actorType: "InternalActor",
          actorName: "state-check",
          diffOld: offBaseline,
          diffNew: baseline,
          timestamp: now,
          severity: "warn",
          resolution: "auto-reverted",
          resolvedAt: now,
          resolvedBy: "cron",
        },
      });
      await prisma.alert.updateMany({
        where: { zoneId: zone.id, action: "PLAY_FROM_DRIFT", resolvedAt: null },
        data: { resolution: "auto-reverted", resolvedAt: now, resolvedBy: "cron" },
      });
      continue;
    }

    result.notificationErrors.push(`state-check revert ${zone.name}: ${failure}`);
    if (!zone.driftDetectedAt) {
      await prisma.zone.update({
        where: { id: zone.id },
        data: { driftDetectedAt: episodeStart, lastSeenPlayFromId: liveId, lastSeenPlayFromName: liveName },
      });
    }

    // One open alert + one notification per drift episode; retried silently after.
    const key = `state-check-failed:${zone.id}:${episodeStart.toISOString()}`;
    const existing = await prisma.alert.findUnique({ where: { syblogId: key } });
    if (existing) continue;
    const alert = await prisma.alert.create({
      data: {
        syblogId: key,
        accountId: account.id,
        zoneId: zone.id,
        action: "PLAY_FROM_DRIFT",
        description: `Zone is off its baseline and the revert failed: ${failure}`.slice(0, 1000),
        actorType: "InternalActor",
        actorName: "state-check",
        diffOld: offBaseline,
        diffNew: baseline,
        timestamp: now,
        severity: "critical",
        resolution: "auto-revert-failed",
      },
    });
    result.alertsCreated += 1;
    const err = await notify(account, zone, alert.id);
    if (err) result.notificationErrors.push(err);
  }
}

/**
 * `Account.lastPolledAt` = last tick where every SYB read succeeded. When reads
 * keep failing past POLL_FAILURE_ALERT_MINUTES, open a POLL_FAILED alert (one per
 * outage, plus a reminder every 24 h) and mark the result unhealthy so the cron
 * run fails visibly instead of logging "successful" with nothing fetched.
 */
async function recordPollHealth(account: AccountRow, result: PollResult): Promise<void> {
  const now = new Date();
  if (result.readErrors.length === 0) {
    await prisma.account.update({ where: { id: account.id }, data: { lastPolledAt: now } });
    await prisma.alert.updateMany({
      where: { accountId: account.id, action: "POLL_FAILED", resolvedAt: null },
      data: { resolution: "recovered", resolvedAt: now, resolvedBy: "cron" },
    });
    return;
  }

  const lastGood = account.lastPolledAt;
  const since = lastGood ?? account.onboardedAt ?? account.createdAt;
  const downMs = now.getTime() - since.getTime();
  if (downMs < pollFailureAlertMs()) return;

  result.unhealthy = true;
  const key = `poll-failed:${account.id}:${since.toISOString()}:${Math.floor(downMs / DAY_MS)}`;
  const existing = await prisma.alert.findUnique({ where: { syblogId: key } });
  if (existing) return;

  const error = result.readErrors[0];
  await prisma.alert.create({
    data: {
      syblogId: key,
      accountId: account.id,
      action: "POLL_FAILED",
      description:
        `Can't read SYB for this account since ${lastGood ? lastGood.toISOString() : "it was added"} ` +
        `(${result.readErrors.length} failed reads this tick). First error: ${error}`.slice(0, 1000),
      actorType: "InternalActor",
      actorName: "monitor",
      timestamp: now,
      severity: "critical",
    },
  });
  result.alertsCreated += 1;
  result.newPollFailure = { businessName: account.businessName, lastGoodPoll: lastGood, error };
}

export async function pollAllMonitoredAccounts(): Promise<PollResult[]> {
  const accounts = await prisma.account.findMany({
    where: { monitored: true },
    select: { id: true },
  });
  const out: PollResult[] = [];
  for (const a of accounts) {
    try {
      out.push(await pollOneAccount(a.id));
    } catch (e) {
      out.push({
        accountId: a.id,
        fetched: 0,
        alertsCreated: 0,
        autoReverted: 0,
        stateCheckReverted: 0,
        readErrors: [(e as Error).message],
        notificationErrors: [],
        unhealthy: true,
        newPollFailure: null,
        cursorAdvanced: false,
        endCursor: null,
      });
    }
  }

  // One ops message per tick for newly failing accounts, not one card each:
  // when SYB breaks it usually breaks for every account at once.
  const newFailures = out.flatMap((r) => (r.newPollFailure ? [r.newPollFailure] : []));
  if (newFailures.length > 0) {
    const lines = [
      `🚨 SYB Monitor can't read SYB for ${newFailures.length} account(s). ` +
        `Drift detection and auto-revert are not working for them.`,
      ...newFailures.map(
        (f) =>
          `• ${f.businessName} — last good poll ${f.lastGoodPoll ? f.lastGoodPoll.toISOString() : "never"}`
      ),
      `First error: ${newFailures[0].error.slice(0, 300)}`,
    ];
    const sent = await dispatchOpsMessage(lines.join("\n"));
    if (sent.errors.length) {
      for (const r of out) {
        if (r.newPollFailure) r.notificationErrors.push(...sent.errors);
      }
    }
  }

  return out;
}
