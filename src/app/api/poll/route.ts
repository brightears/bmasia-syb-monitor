/**
 * Agent-facing single-shot poll-all endpoint.
 *
 * Use this if you'd rather have an external scheduler hit a URL than
 * run the Render cron worker. Bearer-token gated.
 *
 *   curl -X POST -H "Authorization: Bearer $AGENT_API_TOKEN" \
 *     $APP/api/poll
 */

import { NextRequest, NextResponse } from "next/server";
import { requireSessionOrToken, UnauthorizedError } from "@/lib/auth";
import { pollAllMonitoredAccounts } from "@/lib/poll-core";

export async function POST(req: NextRequest) {
  try {
    await requireSessionOrToken(req);
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw e;
  }
  try {
    const results = await pollAllMonitoredAccounts();
    return NextResponse.json({ results });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
