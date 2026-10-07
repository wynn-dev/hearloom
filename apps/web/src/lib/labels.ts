import type { NotificationItem } from "@hearloom/api";
import type { ButtonAction } from "@hearloom/shared";
import type { Tone } from "../components/ui/badge";

export type NotificationStatus = NotificationItem["status"];

export const statusTone: Record<NotificationStatus, Tone> = {
  pending: "info",
  sent: "accent",
  delivered: "good",
  failed: "bad",
  suppressed: "neutral",
};

export const statusLabel: Record<NotificationStatus, string> = {
  pending: "Pending",
  sent: "Sent",
  delivered: "Delivered",
  failed: "Failed",
  suppressed: "Not sent",
};

const reasons: Record<string, string> = {
  quiet_hours: "silent: quiet hours",
  disabled: "alerts turned off",
  // Older agent notifications.
  in_conversation: "silent: in a conversation",
  hourly_limit: "silent: hourly limit",
  hard_limit: "over 30 in an hour",
  source_disabled: "source turned off",
  expired: "expired while held",
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
  agent: "Agent",
};

export const buttonActionLabel: Record<ButtonAction, string> = {
  none: "Do nothing",
  bookmark: "Bookmark this moment",
  mute: "Mute / unmute microphone",
};

export const buttonActions = Object.keys(buttonActionLabel) as ButtonAction[];

export function codecLabel(codec: number): string {
  if (codec === 20 || codec === 21) return "Opus";
  if (codec === 0 || codec === 1) return "PCM";
  return `Codec ${codec}`;
}
