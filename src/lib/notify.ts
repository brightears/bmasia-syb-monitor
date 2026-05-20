/**
 * Alert routing — Google Chat incoming-webhook + Telegram bot fallback.
 *
 * Chat webhook URL and Telegram credentials are env-level globals here;
 * Account.chatSpaceId / Account.telegramChatId are reserved for v2
 * (per-account overrides). For v1 every alert lands in the configured
 * BMAsia Music Ops Chat space + falls back to Telegram if Chat fails.
 */

import type { Alert, Account, Zone } from "@prisma/client";

export interface NotifyContext {
  account: Pick<Account, "id" | "businessName" | "chatSpaceId" | "telegramChatId">;
  zone?: Pick<Zone, "id" | "name" | "approvedPlayFromName"> | null;
  alert: Pick<
    Alert,
    | "id"
    | "action"
    | "description"
    | "actorType"
    | "actorName"
    | "actorEmail"
    | "diffOld"
    | "diffNew"
    | "timestamp"
    | "severity"
    | "resolution"
  >;
  appBaseUrl?: string;
}

function fmtDiff(d: unknown): string {
  if (d === null || d === undefined) return "—";
  if (typeof d === "string") return d;
  if (typeof d === "object") {
    const obj = d as Record<string, unknown>;
    if (obj.name && typeof obj.name === "string") return obj.name;
    if (obj.id && typeof obj.id === "string") return obj.id;
    return JSON.stringify(d).slice(0, 200);
  }
  return String(d);
}

function severityEmoji(sev: string): string {
  if (sev === "critical") return "🚨";
  if (sev === "warn") return "⚠️";
  return "ℹ️";
}

function actorLabel(ctx: NotifyContext): string {
  const a = ctx.alert;
  if (a.actorType === "DeviceActor") {
    return `tablet${a.actorName ? ` (${a.actorName})` : ""}`;
  }
  if (a.actorType === "UserActor" || a.actorType === "ActivityLogUserActor") {
    return a.actorEmail || a.actorName || "logged-in user";
  }
  if (a.actorType === "InternalActor") {
    return `internal/${a.actorName ?? "api"}`;
  }
  return a.actorType;
}

function plainSummary(ctx: NotifyContext): string {
  const { account, zone, alert, appBaseUrl } = ctx;
  const link = appBaseUrl ? `${appBaseUrl}/alerts/${alert.id}` : null;
  const lines = [
    `${severityEmoji(alert.severity)} SYB drift — ${account.businessName}`,
    `Action: ${alert.action}${zone ? ` on zone "${zone.name}"` : ""}`,
    `By: ${actorLabel(ctx)}`,
    `Change: ${fmtDiff(alert.diffOld)} → ${fmtDiff(alert.diffNew)}`,
    zone?.approvedPlayFromName ? `Baseline: ${zone.approvedPlayFromName}` : null,
    alert.resolution ? `Resolution: ${alert.resolution}` : null,
    link ? `View: ${link}` : null,
  ].filter(Boolean);
  return lines.join("\n");
}

// ───────────────────────────── Google Chat ─────────────────────────────

interface ChatCard {
  cardsV2: Array<{
    cardId: string;
    card: {
      header: { title: string; subtitle?: string };
      sections: Array<{
        widgets: Array<{
          decoratedText?: {
            topLabel?: string;
            text: string;
            wrapText?: boolean;
          };
          buttonList?: { buttons: Array<{ text: string; onClick: { openLink: { url: string } } }> };
        }>;
      }>;
    };
  }>;
}

function buildChatCard(ctx: NotifyContext): ChatCard {
  const { account, zone, alert, appBaseUrl } = ctx;
  const widgets: ChatCard["cardsV2"][number]["card"]["sections"][number]["widgets"] = [
    {
      decoratedText: {
        topLabel: "Account",
        text: account.businessName,
      },
    },
    {
      decoratedText: {
        topLabel: "Action",
        text: zone ? `${alert.action} — zone "${zone.name}"` : alert.action,
      },
    },
    {
      decoratedText: {
        topLabel: "Actor",
        text: actorLabel(ctx),
      },
    },
    {
      decoratedText: {
        topLabel: "Change",
        text: `${fmtDiff(alert.diffOld)} → ${fmtDiff(alert.diffNew)}`,
        wrapText: true,
      },
    },
  ];

  if (zone?.approvedPlayFromName) {
    widgets.push({
      decoratedText: {
        topLabel: "Approved baseline",
        text: zone.approvedPlayFromName,
        wrapText: true,
      },
    });
  }

  if (alert.resolution) {
    widgets.push({
      decoratedText: {
        topLabel: "Resolution",
        text: alert.resolution,
      },
    });
  }

  if (appBaseUrl) {
    widgets.push({
      buttonList: {
        buttons: [
          {
            text: "Open alert",
            onClick: { openLink: { url: `${appBaseUrl}/alerts/${alert.id}` } },
          },
        ],
      },
    });
  }

  return {
    cardsV2: [
      {
        cardId: alert.id,
        card: {
          header: {
            title: `${severityEmoji(alert.severity)} SYB drift detected`,
            subtitle: account.businessName,
          },
          sections: [{ widgets }],
        },
      },
    ],
  };
}

async function postChat(webhook: string, ctx: NotifyContext): Promise<void> {
  const card = buildChatCard(ctx);
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify(card),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Chat webhook ${res.status}: ${body.slice(0, 300)}`);
  }
}

// ───────────────────────────── Telegram ─────────────────────────────

async function postTelegram(
  botToken: string,
  chatId: string,
  ctx: NotifyContext
): Promise<void> {
  const text = plainSummary(ctx);
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram ${res.status}: ${body.slice(0, 300)}`);
  }
}

// ───────────────────────────── Public ─────────────────────────────

export interface DispatchResult {
  channels: string[];
  errors: string[];
}

export async function dispatchAlert(ctx: NotifyContext): Promise<DispatchResult> {
  const channels: string[] = [];
  const errors: string[] = [];

  const chatWebhook = process.env.CHAT_WEBHOOK_URL;
  if (chatWebhook) {
    try {
      await postChat(chatWebhook, ctx);
      channels.push("chat");
    } catch (e) {
      errors.push(`chat: ${(e as Error).message}`);
    }
  }

  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChat = ctx.account.telegramChatId ?? process.env.TELEGRAM_CHAT_ID;
  if (tgToken && tgChat) {
    try {
      await postTelegram(tgToken, tgChat, ctx);
      channels.push("telegram");
    } catch (e) {
      errors.push(`telegram: ${(e as Error).message}`);
    }
  }

  if (channels.length === 0) {
    errors.push("no alert channel configured (set CHAT_WEBHOOK_URL or TELEGRAM_*)");
  }

  return { channels, errors };
}
