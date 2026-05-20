/**
 * Capture + compare the approved baseline (playFrom) for each zone.
 *
 *   - captureBaseline: pull current zone state from SYB and store as approved.
 *   - revertToBaseline: fire soundZoneAssignSource(approvedPlayFromId).
 *   - syncZoneInventory: refresh the Zone table for an account from SYB.
 */

import { prisma } from "./prisma";
import { getAccountWithZones, mutateAssignSource } from "./syb-queries";

export interface SyncResult {
  added: string[];
  updated: string[];
  removed: string[];
}

/**
 * Refresh the Zone table for an account based on SYB's current zone list.
 * Does NOT update approved baselines for existing zones — those are only
 * touched via captureBaseline (explicit operator action).
 */
export async function syncZoneInventory(accountId: string): Promise<SyncResult> {
  const remote = await getAccountWithZones(accountId);
  if (!remote) {
    throw new Error(`SYB returned no account for ${accountId}`);
  }

  const existing = await prisma.zone.findMany({ where: { accountId } });
  const existingIds = new Set(existing.map((z) => z.id));
  const remoteIds = new Set(remote.zones.map((z) => z.id));

  const result: SyncResult = { added: [], updated: [], removed: [] };

  // upsert remote zones
  for (const z of remote.zones) {
    const pf = z.playFrom ?? null;
    const lastSeenName = pf?.name ?? null;
    const lastSeenId = pf?.id ?? null;
    // Reflect live SYB staffControl in our Locked column. staffControl=false
    // on the SYB side == zone is locked (staff can't touch it from the tablet).
    const liveStaffControl = z.settings?.staffControl;
    const liveLocked =
      typeof liveStaffControl === "boolean" ? liveStaffControl === false : undefined;
    if (existingIds.has(z.id)) {
      await prisma.zone.update({
        where: { id: z.id },
        data: {
          name: z.name,
          lastSeenPlayFromId: lastSeenId ?? undefined,
          lastSeenPlayFromName: lastSeenName ?? undefined,
          ...(liveLocked !== undefined ? { staffControlLocked: liveLocked } : {}),
        },
      });
      result.updated.push(z.id);
    } else {
      await prisma.zone.create({
        data: {
          id: z.id,
          accountId,
          name: z.name,
          lastSeenPlayFromId: lastSeenId ?? undefined,
          lastSeenPlayFromName: lastSeenName ?? undefined,
          staffControlLocked: liveLocked ?? false,
        },
      });
      result.added.push(z.id);
    }
  }

  // Soft-remove: do NOT cascade-delete zones, just leave them; alerts may
  // still reference them. Could add a `removedAt` field later if needed.
  for (const id of existingIds) {
    if (!remoteIds.has(id)) result.removed.push(id);
  }

  return result;
}

export async function captureBaseline(
  zoneId: string,
  opts: {
    /** If set, override the captured value with an explicit source. */
    overridePlayFromId?: string;
    overridePlayFromName?: string;
    overridePlayFromType?: string;
  } = {}
): Promise<void> {
  const zone = await prisma.zone.findUniqueOrThrow({ where: { id: zoneId } });
  let playFromId = opts.overridePlayFromId ?? zone.lastSeenPlayFromId ?? null;
  let playFromName = opts.overridePlayFromName ?? zone.lastSeenPlayFromName ?? null;
  let playFromType = opts.overridePlayFromType ?? null;

  if (!playFromId) {
    // No local state yet — pull from SYB.
    const remote = await getAccountWithZones(zone.accountId);
    const live = remote?.zones.find((z) => z.id === zoneId);
    if (!live || !live.playFrom) {
      throw new Error(
        `Cannot capture baseline for zone ${zoneId} — no playFrom on the zone right now. Assign one in SYB first.`
      );
    }
    playFromId = live.playFrom.id;
    playFromName = live.playFrom.name ?? null;
    playFromType = live.playFrom.__typename ?? null;
  }

  await prisma.zone.update({
    where: { id: zoneId },
    data: {
      approvedPlayFromId: playFromId,
      approvedPlayFromName: playFromName,
      approvedPlayFromType: playFromType,
      baselineCapturedAt: new Date(),
      driftDetectedAt: null,
    },
  });
}

export async function revertToBaseline(zoneId: string): Promise<{
  reverted: boolean;
  playFromName: string | null;
}> {
  const zone = await prisma.zone.findUniqueOrThrow({ where: { id: zoneId } });
  if (!zone.approvedPlayFromId) {
    throw new Error(`Zone ${zoneId} has no approved baseline.`);
  }
  const result = await mutateAssignSource(zoneId, zone.approvedPlayFromId);
  if (!result) {
    return { reverted: false, playFromName: zone.approvedPlayFromName };
  }
  await prisma.zone.update({
    where: { id: zoneId },
    data: {
      lastSeenPlayFromId: result.id,
      lastSeenPlayFromName: result.name ?? zone.approvedPlayFromName,
      driftDetectedAt: null,
    },
  });
  return { reverted: true, playFromName: result.name ?? zone.approvedPlayFromName };
}
