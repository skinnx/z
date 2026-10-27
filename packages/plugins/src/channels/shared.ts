import type { ChannelRuntime, InboundMessage } from "@z/core";

/** Unaddressed messages only matter when the channel is set to answer everything. */
export function shouldDispatch(message: InboundMessage, runtime: ChannelRuntime): boolean {
  return message.addressed || runtime.channel.always;
}

export function config(runtime: ChannelRuntime, key: string): string {
  return runtime.channel.config[key]?.trim() ?? "";
}
