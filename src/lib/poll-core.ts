/**
 * Poll one account's activity log, write Alert rows idempotently,
 * advance the cursor, dispatch notifications, optionally auto-revert.
 */

import { prisma } from "./prisma";
import { fetchActivityLogPage, type SybActivityLogEntry } from "./syb-queries";
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
  // The diff for reference changes carries the new playlist; the zone itself
  // is implicit on the activityLog scope. SYB's activity log on Account.activityLog
  // returns Account-scoped events; zone-scoped events go through SoundZone.activityLog.
  // Workaround: scan the raw payload for a zone id we know about.
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

  const knownZoneIds = new Set(account.zones.map((z) => z.id));
  const monitoredZoneById = new Map(
    account.zones.filter((z) => z.monitored).map((z) => [z.id, z])
  );

  const pageSize = parseInt(process.env.POLL_PAGE_SIZE ?? "50", 10);

  // Pull a single page. If we land on cursor=null we'll only ever see latest
  // page — which is fine for first run; subsequent runs use the saved cursor.
  const page = await fetchActivityLogPage(accountId, {
    first: pageSize,
    after: account.lastCursor,
  });

  const result: PollResult = {
    accountId,
    fetched: page.entries.length,
    alertsCreated: 0,
    autoReverted: 0,
    notificationErrors: [],
    cursorAdvanced: false,
    endCursor: page.endCursor ?? null,
  };

  // SYB returns entries newest-first by default in activityLog.
  // Process oldest-first to preserve causality.
  const entries = [...page.entries].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp)
  );

  for (const entry of entries) {
    // Idempotency check
    const dup = await prisma.alert.findUnique({ where: { syblogId: entry.id } });
    if (dup) continue;

    if (!ALERTWORTHY.has(entry.action)) continue;
    if (isInternalApiActor(entry)) continue;

    const zoneId = attemptResolveZoneId(entry, knownZoneIds);
    const monitoredZone = zoneId ? monitoredZoneById.get(zoneId) : null;

    // For PLAY_FROM_CHANGED we only alert on monitored zones — drift on
    // unmonitored zones is noise.
    if (entry.action === "PLAY_FROM_CHANGED" && !monitoredZone) continue;

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
    result.alertsCreated += 1;

    // Compare drift vs approved baseline; auto-revert if enabled.
    let resolution: string | null = null;
    if (
      entry.action === "PLAY_FROM_CHANGED" &&
      account.autoRevertEnabled &&
      monitoredZone?.approvedPlayFromId
    ) {
      const newRef = diff.new as { id?: string } | null;
      if (newRef?.id && newRef.id !== monitoredZone.approvedPlayFromId) {
        try {
          await revertToBaseline(monitoredZone.id);
          resolution = "auto-reverted";
          result.autoReverted += 1;
        } catch (e) {
          result.notificationErrors.push(
            `auto-revert ${monitoredZone.id}: ${(e as Error).message}`
          );
        }
      } else if (newRef?.id === monitoredZone.approvedPlayFromId) {
        resolution = "ignored:matches-baseline";
      }
    }

    if (resolution) {
      await prisma.alert.update({
        where: { id: alert.id },
        data: {
          resolution,
          resolvedAt: new Date(),
          resolvedBy: "cron",
        },
      });
    }

    // Chat notification policy ("Mode B"):
    //   - Skip when auto-revert handled it cleanly (resolution=auto-reverted)
    //     — the audit row still exists at /alerts but no Chat ping
    //   - Skip when the new source already matched baseline (no-op drift)
    //   - Always Chat for non-drift events (ACCOUNT_SETTING_CHANGED,
    //     DEVICE_UNPAIRED, TRACK_BLOCKED, etc.) and drift that wasn't
    //     auto-reverted (either autoRevert OFF, or revert failed)
    const skipChat =
      resolution === "auto-reverted" || resolution === "ignored:matches-baseline";

    if (!skipChat) {
      const fresh = await prisma.alert.findUniqueOrThrow({ where: { id: alert.id } });
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
      if (dispatch.errors.length) result.notificationErrors.push(...dispatch.errors);
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
  }

  if (page.endCursor) {
    await prisma.account.update({
      where: { id: accountId },
      data: { lastCursor: page.endCursor, lastPolledAt: new Date() },
    });
    result.cursorAdvanced = true;
  } else {
    await prisma.account.update({
      where: { id: accountId },
      data: { lastPolledAt: new Date() },
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
