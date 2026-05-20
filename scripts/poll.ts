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

async function onePass(): Promise<void> {
  const start = Date.now();
  const results = await pollAllMonitoredAccounts();
  const totals = results.reduce(
    (acc, r) => {
      acc.fetched += r.fetched;
      acc.alerts += r.alertsCreated;
      acc.reverted += r.autoReverted;
      acc.errors += r.notificationErrors.length;
      return acc;
    },
    { fetched: 0, alerts: 0, reverted: 0, errors: 0 }
  );
  const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `[poll] ${results.length} accounts | ${totals.fetched} entries fetched | ` +
      `${totals.alerts} new alerts | ${totals.reverted} auto-reverted | ${totals.errors} notify-errors | ${elapsedSec}s`
  );
  for (const r of results) {
    if (r.notificationErrors.length || r.alertsCreated > 0) {
      console.log(
        `  ${r.accountId}: fetched=${r.fetched} alerts=${r.alertsCreated} ` +
          `reverted=${r.autoReverted} cursor=${r.cursorAdvanced ? "advanced" : "held"} ` +
          (r.notificationErrors.length ? `errors=${r.notificationErrors.join("; ")}` : "")
      );
    }
  }
}

async function main(): Promise<void> {
  const once = process.argv.includes("--once");
  try {
    if (once) {
      await onePass();
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
