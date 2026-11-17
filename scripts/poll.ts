/**
 * Cron entry point.
 *
 *   npm run poll:once  → single pass over all monitored accounts, exit
 *   npm run poll       → loop forever, POLL_LOOP_INTERVAL_SECONDS between passes
 *
 * Render's cron service runs poll:once; local dev uses the loop.
 */

import { pollAllMonitoredAccounts } from "../src/lib/poll-core";
import { prisma } from "../src/lib/prisma";

/** Returns how many accounts are unhealthy (SYB unreadable past the alert threshold). */
async function onePass(): Promise<number> {
  const start = Date.now();
  const results = await pollAllMonitoredAccounts();
  const totals = results.reduce(
    (acc, r) => {
      acc.fetched += r.fetched;
      acc.alerts += r.alertsCreated;
      acc.reverted += r.autoReverted;
      acc.stateCheck += r.stateCheckReverted;
      acc.readErrors += r.readErrors.length;
      acc.errors += r.notificationErrors.length;
      if (r.unhealthy) acc.unhealthy += 1;
      return acc;
    },
    { fetched: 0, alerts: 0, reverted: 0, stateCheck: 0, readErrors: 0, errors: 0, unhealthy: 0 }
  );
  const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `[poll] ${results.length} accounts | ${totals.fetched} entries fetched | ` +
      `${totals.alerts} new alerts | ${totals.reverted} auto-reverted (${totals.stateCheck} by state check) | ` +
      `${totals.readErrors} read-errors | ${totals.errors} other-errors | ${elapsedSec}s`
  );
  for (const r of results) {
    if (r.readErrors.length || r.notificationErrors.length || r.alertsCreated > 0 || r.autoReverted > 0) {
      console.log(
        `  ${r.accountId}: fetched=${r.fetched} alerts=${r.alertsCreated} ` +
          `reverted=${r.autoReverted} state-check=${r.stateCheckReverted} ` +
          `cursor=${r.cursorAdvanced ? "advanced" : "held"}` +
          (r.unhealthy ? " UNHEALTHY" : "") +
          (r.readErrors.length ? ` read-errors=${r.readErrors.join("; ")}` : "") +
          (r.notificationErrors.length ? ` errors=${r.notificationErrors.join("; ")}` : "")
      );
    }
  }
  return totals.unhealthy;
}

async function main(): Promise<void> {
  const once = process.argv.includes("--once");
  try {
    if (once) {
      const unhealthy = await onePass();
      if (unhealthy > 0) {
        // Fail the run so Render shows it (and emails) instead of "successful"
        // while nothing is being read. Readable accounts were still processed.
        console.error(`[poll] ${unhealthy} account(s) unreadable past the alert threshold — exiting 1`);
        process.exitCode = 1;
      }
      return;
    }
    const intervalSec = parseInt(process.env.POLL_LOOP_INTERVAL_SECONDS ?? "600", 10);
    console.log(`[poll] loop mode — every ${intervalSec}s`);
    while (true) {
      try {
        await onePass();
      } catch (e) {
        console.error(`[poll] pass failed: ${(e as Error).message}`);
      }
      await new Promise((res) => setTimeout(res, intervalSec * 1000));
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
