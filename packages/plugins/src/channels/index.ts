import { definePlugin } from "@z/core";
import { discordAdapter } from "./discord.ts";
import { slackAdapter } from "./slack.ts";
import { telegramAdapter } from "./telegram.ts";
import { webhookAdapter } from "./webhook.ts";
import { xAdapter } from "./x.ts";

export default definePlugin({
  id: "channels",
  name: "Channels",
  description: "Summon the bot from Telegram, Slack, Discord, X or any app via webhook.",
  adapters: [webhookAdapter, telegramAdapter, slackAdapter, discordAdapter, xAdapter],
});
