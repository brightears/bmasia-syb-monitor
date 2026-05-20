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

  // 2) per monitored zone: staffControl=false
  for (const zone of acc.zones) {
    if (!zone.monitored) {
      result.zonesSkipped.push(zone.id);
      continue;
    }
    try {
      await mutateZoneSettings(zone.id, { staffControl: false });
      await prisma.appliedSetting.create({
        data: {
          accountId,
          scope: `zone:${zone.id}`,
          settingName: "staffControl",
          value: "false",
          appliedBy: opts.appliedBy ?? "system",
        },
      });
      await prisma.zone.update({
        where: { id: zone.id },
        data: { staffControlLocked: true },
      });
      result.zonesLocked.push(zone.id);
    } catch (e) {
      result.errors.push({
        scope: `zone:${zone.id}`,
        message: (e as Error).message,
      });
    }
  }

  if (result.errors.length === 0) {
    await prisma.account.update({
      where: { id: accountId },
      data: { preventionApplied: true, onboardedAt: acc.onboardedAt ?? new Date() },
    });
  }

  return result;
}
