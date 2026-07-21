/**
 * Named SYB queries + mutations the monitor uses.
 *
 * Keep this file mutation-aware — every fn here that mutates is exported
 * with a `mutate*` prefix so callers grep-find them and gate properly.
 */

import { graphql } from "./syb";

// ───────────────────────────── Types ─────────────────────────────

export interface SybAccount {
  id: string;
  businessName: string;
}

export interface SybZone {
  id: string;
  name: string;
  playFrom?: {
    __typename?: string;
    id: string;
    name?: string;
  } | null;
  settings?: {
    staffControl?: boolean | null;
  } | null;
}

export interface SybActivityLogActor {
  __typename: string;
  device?: { id?: string; name?: string; platform?: string; type?: string };
  user?: { id?: string; name?: string; email?: string };
  name?: string; // InternalActor.name (e.g. "public_api")
  raw?: unknown;
}

export interface SybActivityLogEntry {
  id: string;
  timestamp: string;
  action: string;
  description?: string | null;
  actor: SybActivityLogActor | null;
  diff: {
    type?: string;
    old?: unknown;
    new?: unknown;
  } | null;
}

export interface SybActivityLogPage {
  total?: number;
  endCursor?: string | null;
  hasNextPage: boolean;
  entries: SybActivityLogEntry[];
}

// ───────────────────────────── Queries ─────────────────────────────

const ACCOUNTS_PAGE_QUERY = `
  query AccountsPage($first: Int!, $after: String) {
    me {
      ... on PublicAPIClient {
        accounts(first: $first, after: $after) {
          edges {
            cursor
            node { id businessName }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

interface AccountsPageResp {
  me: {
    accounts: {
      edges: { cursor: string; node: SybAccount }[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  } | null;
}

/**
 * Fetch ALL accounts visible to the operator token, walking the cursor to the
 * end of the connection, then return them sorted by name.
 *
 * This used to take a fixed `limit` (default 200; the API route passed 500) and
 * stop once that many rows were collected. BMAsia has more accounts than the
 * cap, so the "Add account" picker silently ended mid-alphabet — anything past
 * the cutoff (e.g. "Park Hyatt Maldives Hadahaa") was never fetched, and the
 * client-side filter couldn't match what was never loaded. We now page to the
 * end.
 *
 * `maxPages` is a hard iteration ceiling so a misbehaving connection (a cursor
 * that advances but yields no new rows, or `hasNextPage` stuck true) can't spin
 * the request loop forever. At pageSize 50, the default covers 10k accounts. If
 * we ever stop while SYB still reports more, we warn so the truncation is
 * greppable in the logs rather than silent.
 */
export async function listAccounts(maxPages = 200): Promise<SybAccount[]> {
  const out: SybAccount[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let truncated = false;
  const pageSize = 50;

  for (let page = 0; page < maxPages; page++) {
    const data: AccountsPageResp = await graphql<AccountsPageResp>(
      ACCOUNTS_PAGE_QUERY,
      { first: pageSize, after: cursor }
    );
    const conn = data.me?.accounts;
    if (!conn) break;

    let added = 0;
    for (const edge of conn.edges) {
      if (seen.has(edge.node.id)) continue; // defensive de-dup
      seen.add(edge.node.id);
      out.push(edge.node);
      added++;
    }

    if (!conn.pageInfo.hasNextPage) break; // reached the end — the normal exit

    // Non-terminating signatures: no/duplicate cursor, or a page that claims
    // "more" but added nothing new. Bail instead of looping forever.
    const next = conn.pageInfo.endCursor;
    if (!next || next === cursor || added === 0) {
      truncated = true;
      break;
    }
    cursor = next;

    if (page === maxPages - 1) truncated = true; // hit the ceiling with more to go
  }

  if (truncated) {
    console.warn(
      `[listAccounts] returned ${out.length} accounts but SYB still reports more — ` +
        `list may be truncated (cursor stalled or maxPages=${maxPages} hit). Investigate / raise maxPages.`
    );
  }

  // Case-/accent-insensitive so "MELIÁ" sorts with "Melia" and the picker reads
  // as a clean A→Z list instead of SYB's raw ordering.
  return out.sort((a, b) =>
    a.businessName.localeCompare(b.businessName, undefined, {
      sensitivity: "base",
      numeric: true,
    })
  );
}

const ACCOUNT_WITH_ZONES_QUERY = `
  query AccountWithZones($id: ID!) {
    account(id: $id) {
      id
      businessName
      settings {
        enableActivityLog
        restrictEditMusic
        restrictDiscoverMusic
        restrictBlockTracks
        restrictUnpairingFromPairedDevices
      }
      locations(first: 100) {
        edges {
          node {
            id
            name
            soundZones(first: 100) {
              edges {
                node {
                  id
                  name
                  playFrom { __typename ... on Playlist { id name } ... on Schedule { id name } }
                  settings { staffControl }
                }
              }
            }
          }
        }
      }
    }
  }
`;

export interface AccountFullState {
  id: string;
  businessName: string;
  settings: {
    enableActivityLog?: boolean | null;
    restrictEditMusic?: boolean | null;
    restrictDiscoverMusic?: boolean | null;
    restrictBlockTracks?: boolean | null;
    restrictUnpairingFromPairedDevices?: boolean | null;
  };
  zones: Array<
    SybZone & {
      locationId: string;
      locationName: string;
    }
  >;
}

export async function getAccountWithZones(
  accountId: string
): Promise<AccountFullState | null> {
  const data = await graphql<{ account: any }>(ACCOUNT_WITH_ZONES_QUERY, {
    id: accountId,
  });
  const a = data.account;
  if (!a) return null;

  const zones: AccountFullState["zones"] = [];
  for (const locEdge of a.locations?.edges ?? []) {
    const loc = locEdge.node;
    for (const zEdge of loc.soundZones?.edges ?? []) {
      const z = zEdge.node;
      zones.push({
        id: z.id,
        name: z.name,
        playFrom: z.playFrom ?? null,
        settings: z.settings ?? null,
        locationId: loc.id,
        locationName: loc.name,
      });
    }
  }

  return {
    id: a.id,
    businessName: a.businessName,
    settings: a.settings ?? {},
    zones,
  };
}

const ACTIVITY_LOG_QUERY = `
  query AccountActivityLog($id: ID!, $first: Int!, $after: String) {
    account(id: $id) {
      activityLog(first: $first, after: $after) {
        total
        edges {
          cursor
          node {
            id
            timestamp
            action
            description
            actor {
              entity {
                __typename
                ... on DeviceActor {
                  device { id name type platform osVersion }
                }
                ... on UserActor {
                  user { id name email }
                }
                ... on ActivityLogUserActor {
                  user { id name email }
                }
                ... on InternalActor {
                  name
                }
              }
            }
            diff {
              type
              diffEntity {
                __typename
                ... on ActivityLogJSONDiff { old new }
                ... on ActivityLogReferenceDiff {
                  old {
                    __typename
                    ... on PlaylistReference { playlist { id name } }
                    ... on ScheduleReference { schedule { id name } }
                    ... on DeviceReference { device { id name } }
                    ... on TrackReference { track { id name } }
                  }
                  new {
                    __typename
                    ... on PlaylistReference { playlist { id name } }
                    ... on ScheduleReference { schedule { id name } }
                    ... on DeviceReference { device { id name } }
                    ... on TrackReference { track { id name } }
                  }
                }
              }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

function normalizeActor(rawActor: any): SybActivityLogActor | null {
  if (!rawActor) return null;
  const ent = rawActor.entity ?? rawActor;
  const typeName = ent?.__typename ?? "Unknown";
  const out: SybActivityLogActor = { __typename: typeName, raw: ent };
  if (ent?.device) out.device = ent.device;
  if (ent?.user) out.user = ent.user;
  if (ent?.name) out.name = ent.name;
  return out;
}

function normalizeDiff(rawDiff: any): SybActivityLogEntry["diff"] {
  if (!rawDiff) return null;
  const ent = rawDiff.diffEntity ?? {};
  const kind = ent?.__typename ?? rawDiff.type ?? null;
  if (kind === "ActivityLogJSONDiff") {
    return { type: "json", old: ent.old ?? null, new: ent.new ?? null };
  }
  if (kind === "ActivityLogReferenceDiff") {
    return { type: "reference", old: ent.old ?? null, new: ent.new ?? null };
  }
  return { type: rawDiff.type ?? "unknown", old: null, new: null };
}

export async function fetchActivityLogPage(
  accountId: string,
  opts: { first?: number; after?: string | null } = {}
): Promise<SybActivityLogPage> {
  const first = opts.first ?? 50;
  const after = opts.after ?? null;
  const data = await graphql<{ account: any }>(ACTIVITY_LOG_QUERY, {
    id: accountId,
    first,
    after,
  });
  const log = data.account?.activityLog;
  if (!log) {
    return { total: 0, endCursor: null, hasNextPage: false, entries: [] };
  }
  const entries: SybActivityLogEntry[] = (log.edges ?? []).map((e: any) => ({
    id: e.node.id,
    timestamp: e.node.timestamp,
    action: e.node.action,
    description: e.node.description ?? null,
    actor: normalizeActor(e.node.actor),
    diff: normalizeDiff(e.node.diff),
  }));
  return {
    total: log.total,
    endCursor: log.pageInfo?.endCursor ?? null,
    hasNextPage: !!log.pageInfo?.hasNextPage,
    entries,
  };
}

// PLAY_FROM_CHANGED + most zone-touching events live on SoundZone.activityLog,
// not Account.activityLog. Account.activityLog only surfaces account-scoped
// events (ACCOUNT_SETTING_CHANGED, user-mgmt). For drift detection we poll
// per-monitored-zone.
const SOUND_ZONE_ACTIVITY_LOG_QUERY = `
  query SoundZoneActivityLog($id: ID!, $first: Int!, $after: String) {
    soundZone(id: $id) {
      activityLog(first: $first, after: $after) {
        total
        edges {
          cursor
          node {
            id
            timestamp
            action
            description
            actor {
              entity {
                __typename
                ... on DeviceActor {
                  device { id name type platform osVersion }
                }
                ... on UserActor {
                  user { id name email }
                }
                ... on ActivityLogUserActor {
                  user { id name email }
                }
                ... on InternalActor {
                  name
                }
              }
            }
            diff {
              type
              diffEntity {
                __typename
                ... on ActivityLogJSONDiff { old new }
                ... on ActivityLogReferenceDiff {
                  old {
                    __typename
                    ... on PlaylistReference { playlist { id name } }
                    ... on ScheduleReference { schedule { id name } }
                    ... on DeviceReference { device { id name } }
                    ... on TrackReference { track { id name } }
                  }
                  new {
                    __typename
                    ... on PlaylistReference { playlist { id name } }
                    ... on ScheduleReference { schedule { id name } }
                    ... on DeviceReference { device { id name } }
                    ... on TrackReference { track { id name } }
                  }
                }
              }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export async function fetchSoundZoneActivityLogPage(
  soundZoneId: string,
  opts: { first?: number; after?: string | null } = {}
): Promise<SybActivityLogPage> {
  const first = opts.first ?? 50;
  const after = opts.after ?? null;
  const data = await graphql<{ soundZone: any }>(SOUND_ZONE_ACTIVITY_LOG_QUERY, {
    id: soundZoneId,
    first,
    after,
  });
  const log = data.soundZone?.activityLog;
  if (!log) {
    return { total: 0, endCursor: null, hasNextPage: false, entries: [] };
  }
  const entries: SybActivityLogEntry[] = (log.edges ?? []).map((e: any) => ({
    id: e.node.id,
    timestamp: e.node.timestamp,
    action: e.node.action,
    description: e.node.description ?? null,
    actor: normalizeActor(e.node.actor),
    diff: normalizeDiff(e.node.diff),
  }));
  return {
    total: log.total,
    endCursor: log.pageInfo?.endCursor ?? null,
    hasNextPage: !!log.pageInfo?.hasNextPage,
    entries,
  };
}

// ───────────────────────────── Mutations (gated by caller) ─────────────────────────────

const ACCOUNT_UPDATE_SETTINGS = `
  mutation AccountUpdate($input: AccountUpdateInput!) {
    accountUpdate(input: $input) {
      account {
        id
        settings {
          enableActivityLog
          restrictEditMusic
          restrictDiscoverMusic
          restrictBlockTracks
          restrictUnpairingFromPairedDevices
        }
      }
    }
  }
`;

export interface PreventionAccountSettings {
  enableActivityLog?: boolean;
  restrictEditMusic?: boolean;
  restrictDiscoverMusic?: boolean;
  restrictBlockTracks?: boolean;
  restrictUnpairingFromPairedDevices?: boolean;
}

export async function mutateAccountSettings(
  accountId: string,
  settings: PreventionAccountSettings
): Promise<void> {
  await graphql(ACCOUNT_UPDATE_SETTINGS, {
    input: { id: accountId, settings },
  });
}

const ZONE_UPDATE_SETTINGS = `
  mutation SoundZoneUpdateSettings($input: SoundZoneUpdateSettingsInput!) {
    soundZoneUpdateSettings(input: $input) {
      soundZones
      settings { staffControl }
    }
  }
`;

export async function mutateZoneSettings(
  zoneIdOrIds: string | string[],
  settings: { staffControl?: boolean }
): Promise<void> {
  const soundZones = Array.isArray(zoneIdOrIds) ? zoneIdOrIds : [zoneIdOrIds];
  await graphql(ZONE_UPDATE_SETTINGS, {
    input: { soundZones, settings },
  });
}

const ZONE_ASSIGN_SOURCE = `
  mutation SoundZoneAssignSource($input: SoundZoneAssignSourceInput!) {
    soundZoneAssignSource(input: $input) {
      soundZones
      source { __typename ... on Playlist { id name } ... on Schedule { id name } }
    }
  }
`;

export async function mutateAssignSource(
  zoneIdOrIds: string | string[],
  sourceId: string
): Promise<{ id: string; name?: string; typeName?: string } | null> {
  const soundZones = Array.isArray(zoneIdOrIds) ? zoneIdOrIds : [zoneIdOrIds];
  const data = await graphql<{
    soundZoneAssignSource: { soundZones: string[]; source: any };
  }>(ZONE_ASSIGN_SOURCE, {
    input: { soundZones, source: sourceId },
  });
  const src = data.soundZoneAssignSource?.source;
  if (!src) return null;
  return { id: src.id, name: src.name, typeName: src.__typename };
}
