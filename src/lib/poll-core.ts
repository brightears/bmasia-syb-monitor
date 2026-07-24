/**
 * Poll one account's activity log, write Alert rows idempotently,
 * advance the cursor, dispatch notifications, optionally auto-revert.
 */

import { prisma } from "./prisma";
import {
  fetchActivityLogPage,
  fetchSoundZoneActivityLogPage,
  type SybActivityLogEntry,
} from "./syb-queries";
import { revertToBaseline } from "./baseline";
import { dispatchAlert } from "./notify";

/** Actions we treat as alert-worthy. Other actions still get cursor-advanced through. */
const ALERTWORTHY = new Set([
  "PLAY_FROM_CHANGED",
  "ACCOUNT_SETTING_CHANGED",
  "DEVICE_UNPAIRED",
  "DEVICE_PAIRED",
  "TRACK_BLOCKED",
  "SOUND_ZONE_SETTING_CHANGED",
]);

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
  autoReverted: number;
  notificationErrors: string[];
  cursorAdvanced: boolean;
  endCursor: string | null;
}

export async function pollOneAccount(accountId: string): Promise<PollResult> {
  const account = await prisma.account.findUniqueOrThrow({
    where: { id: accountId },
    include: { zones: true },
  });

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
    notificationErrors: [],
    cursorAdvanced: false,
    endCursor: null,
  };

  // Process the per-zone activityLog for every monitored zone. Account-level
  // activityLog is polled separately at the end for ACCOUNT_SETTING_CHANGED.
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
      result.notificationErrors.push(
        `fetch ${zone.id}: ${(e as Error).message}`
      );
      continue;
    }

    result.fetched += zonePage.entries.length;

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
  const acctIsFirstRun = account.lastCursor === null;
  const acctFetchSize = acctIsFirstRun ? 1 : pageSize;
  const acctPage = await fetchActivityLogPage(accountId, {
    first: acctFetchSize,
    after: null,
  });

  result.fetched += acctPage.entries.length;

  if (acctIsFirstRun) {
    // Anchor: any non-null value flips us out of first-run on the next tick.
    await prisma.account.update({
      where: { id: accountId },
      data: {
        lastCursor: acctPage.endCursor ?? "anchored",
        lastPolledAt: new Date(),
      },
    });
    if (acctPage.endCursor) {
      result.cursorAdvanced = true;
      result.endCursor = acctPage.endCursor;
    }
    return result;
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

  await prisma.account.update({
    where: { id: accountId },
    data: { lastPolledAt: new Date() },
  });

  return result;
}

interface ProcessEntryResult {
  alertCreated: boolean;
  autoReverted: boolean;
  error: string | null;
}

async function processEntry(
  entry: SybActivityLogEntry,
  account: {
    id: string;
    businessName: string;
    autoRevertEnabled: boolean;
    chatSpaceId: string | null;
    telegramChatId: string | null;
  },
  zoneId: string | null,
  monitoredZoneById: Map<
    string,
    {
      id: string;
      name: string;
      approvedPlayFromId: string | null;
      approvedPlayFromName: string | null;
    }
  >
): Promise<ProcessEntryResult> {
  const result: ProcessEntryResult = {
    alertCreated: false,
    autoReverted: false,
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
    },
  });
  result.alertCreated = true;

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
          result.error =
            `auto-revert ${monitoredZone.id}: didn't take — still on ` +
            `"${rev.observedPlayFromName ?? "another source"}"`;
        }
      } catch (e) {
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
    const fresh = await prisma.alert.findUniqueOrThrow({
      where: { id: alert.id },
    });
    const dispatch = await dispatchAlert({
      account: {
        id: account.id,
        businessName: account.businessName,
        chatSpaceId: account.chatSpaceId,
        telegramChatId: account.telegramChatId,
      },
      zone: monitoredZone
        ? {
            id: monitoredZone.id,
            name: monitoredZone.name,
            approvedPlayFromName: monitoredZone.approvedPlayFromName,
          }
        : null,
      alert: fresh,
      appBaseUrl: process.env.NEXT_PUBLIC_APP_URL,
    });
    if (dispatch.errors.length) {
      result.error = (result.error ? result.error + "; " : "") + dispatch.errors.join("; ");
    }
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
        notificationErrors: [(e as Error).message],
        cursorAdvanced: false,
        endCursor: null,
      });
    }
  }
  return out;
}
