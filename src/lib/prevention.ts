/**
 * Apply the BMAsia prevention layer to an opted-in account.
 *
 *   - enableActivityLog: true  (required for monitoring to work at all)
 *   - restrictEditMusic: true
 *   - restrictDiscoverMusic: true
 *   - restrictBlockTracks: true
 *   - restrictUnpairingFromPairedDevices: true
 *   - per monitored zone: staffControl: false
 *
 * Idempotent — safe to re-run. Records each applied setting in AppliedSetting
 * so we can detect tamper later.
 */

import { prisma } from "./prisma";
import {
  mutateAccountSettings,
  mutateZoneSettings,
  type PreventionAccountSettings,
} from "./syb-queries";

const ACCOUNT_DEFAULTS: PreventionAccountSettings = {
  enableActivityLog: true,
  restrictEditMusic: true,
  restrictDiscoverMusic: true,
  restrictBlockTracks: true,
  restrictUnpairingFromPairedDevices: true,
};

export interface PreventionResult {
  accountSettingsApplied: PreventionAccountSettings;
  zonesLocked: string[];
  zonesSkipped: string[];
  errors: Array<{ scope: string; message: string }>;
}

export async function applyPrevention(
  accountId: string,
  opts: {
    appliedBy?: string;
    overrideAccountSettings?: Partial<PreventionAccountSettings>;
  } = {}
): Promise<PreventionResult> {
  const acc = await prisma.account.findUniqueOrThrow({
    where: { id: accountId },
    include: { zones: true },
  });

  if (!acc.monitored) {
    throw new Error(
      `Account ${accountId} is not flagged monitored — flip it on before applying prevention.`
    );
  }

  const accountSettings: PreventionAccountSettings = {
    ...ACCOUNT_DEFAULTS,
    ...opts.overrideAccountSettings,
  };

  const result: PreventionResult = {
    accountSettingsApplied: accountSettings,
    zonesLocked: [],
    zonesSkipped: [],
    errors: [],
  };

  // 1) account-level settings
  try {
    await mutateAccountSettings(accountId, accountSettings);
    for (const [k, v] of Object.entries(accountSettings)) {
      await prisma.appliedSetting.create({
        data: {
          accountId,
          scope: "account",
          settingName: k,
          value: String(v),
          appliedBy: opts.appliedBy ?? "system",
        },
      });
    }
  } catch (e) {
    result.errors.push({
      scope: "account",
      message: (e as Error).message,
    });
  }

  // Per-zone staffControl was previously fired here. Removed because the
  // BMAsia operator-scope SYB token returns Forbidden on
  // soundZoneUpdateSettings — staffControl needs higher scope than we have.
  // The Locked column on the dashboard still reflects live SYB state, so
  // if staffControl gets set elsewhere (admin UI / different token) the
  // column will show it after the next Sync now.

  if (result.errors.length === 0) {
    await prisma.account.update({
      where: { id: accountId },
      data: { preventionApplied: true, onboardedAt: acc.onboardedAt ?? new Date() },
    });
  }

  return result;
}
