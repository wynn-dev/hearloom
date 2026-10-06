import type { NotificationItem } from "@hearloom/api";
import type { ButtonAction } from "@hearloom/shared";
import type { Tone } from "../components/ui/badge";

export type NotificationStatus = NotificationItem["status"];

export const statusTone: Record<NotificationStatus, Tone> = {
  pending: "info",
  held: "warn",
  sent: "accent",
  delivered: "good",
  failed: "bad",
  suppressed: "neutral",
};

export const statusLabel: Record<NotificationStatus, string> = {
  pending: "Pending",
  held: "Held",
  sent: "Sent",
  delivered: "Delivered",
  failed: "Failed",
  suppressed: "Suppressed",
};

const reasons: Record<string, string> = {
  quiet_hours: "quiet hours",
  in_conversation: "in a conversation",
  rate_limited: "hourly cap reached",
  replaced: "replaced by a newer one",
  source_disabled: "source turned off",
  apns_not_configured: "APNs not configured",
  no_phones: "no phones registered",
  no_push_token: "no push token",
  all_channels_failed: "all channels failed",
};

export function reasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return reasons[reason] ?? reason.replaceAll("_", " ");
}

export const interruptionLabel: Record<NotificationItem["interruptionLevel"], string> = {
  passive: "Passive",
  active: "Active",
  "time-sensitive": "Time-sensitive",
};

export const sourceLabel: Record<NotificationItem["source"], string> = {
  system: "System",
  rule: "Rule",
  agent: "Agent",
};

export const feedbackLabel: Record<NonNullable<NotificationItem["feedback"]>, string> = {
  useful: "Marked useful",
  not_useful: "Marked not useful",
  snoozed: "Snoozed",
};

export const buttonActionLabel: Record<ButtonAction, string> = {
  none: "Do nothing",
  bookmark: "Bookmark this moment",
  mute: "Mute / unmute microphone",
  ack_nudge: "Acknowledge latest nudge",
};

export const buttonActions = Object.keys(buttonActionLabel) as ButtonAction[];

export function codecLabel(codec: number): string {
  if (codec === 20 || codec === 21) return "Opus";
  if (codec === 0 || codec === 1) return "PCM";
  return `Codec ${codec}`;
}
