import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const webhook = process.env.DISCORD_WEBHOOK_URL;
if (!webhook) {
  console.log("ScopePulse: DISCORD_WEBHOOK_URL is not configured; notification skipped.");
  process.exit(0);
}

const run = JSON.parse(await readFile(resolve(import.meta.dirname, "..", ".radar-run.json"), "utf8"));
if (!run.events?.length || run.baseline) {
  console.log("ScopePulse: no new events to notify.");
  process.exit(0);
}

const lines = run.events.slice(0, 8).map((event) =>
  `**${event.change.label}** · ${event.programName} · edge ${event.score}/100\n${event.url}`,
);
const more = run.events.length > 8 ? `\n…and ${run.events.length - 8} more in the dashboard.` : "";
const content = `📡 **ScopePulse found ${run.events.length} bounty change${run.events.length === 1 ? "" : "s"}**\n\n${lines.join("\n\n")}${more}`;
const response = await fetch(webhook, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ content: content.slice(0, 1_950) }),
  signal: AbortSignal.timeout(15_000),
});
if (!response.ok) throw new Error(`Discord webhook returned HTTP ${response.status}`);
console.log("ScopePulse: Discord notification sent.");
