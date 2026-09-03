import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const webhook = process.env.DISCORD_WEBHOOK_URL;
if (!webhook) {
  console.log("ScoutIQ: DISCORD_WEBHOOK_URL is not configured; notification skipped.");
  process.exit(0);
}

const run = JSON.parse(await readFile(resolve(import.meta.dirname, "..", ".radar-run.json"), "utf8"));
const payableEvents = (run.events ?? []).filter((event) => !event.excludeReason && Number(event.evScore ?? 0) > 0);
if (!payableEvents.length || run.baseline) {
  console.log("ScoutIQ: no new payable events to notify.");
  process.exit(0);
}

const lines = payableEvents.slice(0, 8).map((event) =>
  `**${event.change.label}** · ${event.programName} · ${event.workflow} · EV $${Math.round(event.evScore).toLocaleString()}\n${event.url}`,
);
const more = payableEvents.length > 8 ? `\n…and ${payableEvents.length - 8} more in the dashboard.` : "";
const content = `📡 **ScoutIQ found ${payableEvents.length} payable candidate change${payableEvents.length === 1 ? "" : "s"}**\n\n${lines.join("\n\n")}${more}`;
const response = await fetch(webhook, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ content: content.slice(0, 1_950) }),
  signal: AbortSignal.timeout(15_000),
});
if (!response.ok) throw new Error(`Discord webhook returned HTTP ${response.status}`);
console.log("ScoutIQ: Discord notification sent.");
