import * as Application from "expo-application";
import * as Notifications from "expo-notifications";
import type { Rpc } from "./session";

/** Show notifications while the app is open, too. */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/** Categories must match the server (`HL_NUDGE`, `HL_SYSTEM`) — see apps/server/src/notify/apns.ts. */
export async function registerCategories(): Promise<void> {
  await Notifications.setNotificationCategoryAsync("HL_NUDGE", [
    { identifier: "useful", buttonTitle: "Useful", options: { opensAppToForeground: false } },
    {
      identifier: "not_useful",
      buttonTitle: "Not useful",
      options: { opensAppToForeground: false },
    },
    {
      identifier: "reply",
      buttonTitle: "Reply",
      textInput: { submitButtonTitle: "Send", placeholder: "Reply to Hearloom…" },
      options: { opensAppToForeground: false },
    },
  ]);
  await Notifications.setNotificationCategoryAsync("HL_SYSTEM", [
    { identifier: "open", buttonTitle: "Open", options: { opensAppToForeground: true } },
  ]);
}

export type PushState = "granted" | "denied" | "undetermined" | "error";

/** Ask for permission (once), then send the APNs device token to the server. */
export async function registerForPush(rpc: Rpc, phoneId: string): Promise<PushState> {
  const current = await Notifications.getPermissionsAsync();
  let status = current.status;
  if (status === "undetermined") {
    status = (
      await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowSound: true, allowBadge: false },
      })
    ).status;
  }
  if (status !== "granted") return status === "denied" ? "denied" : "undetermined";
  try {
    const token = await Notifications.getDevicePushTokenAsync();
    const env = await Application.getIosPushNotificationServiceEnvironmentAsync();
    await rpc.phones.setPushToken({
      phoneId,
      apnsToken: String(token.data),
      apnsEnv: env === "production" ? "production" : "sandbox",
    });
    return "granted";
  } catch (err) {
    console.warn("push registration failed", err);
    return "error";
  }
}

export interface HearloomNotificationData {
  hlId?: string;
  deepLink?: string;
}

export function notificationData(n: Notifications.Notification): HearloomNotificationData {
  return (n.request.content.data ?? {}) as HearloomNotificationData;
}

/** Map a notification action to server feedback. */
export function feedbackFor(response: Notifications.NotificationResponse): {
  action: "opened" | "useful" | "not_useful" | "reply";
  replyText?: string;
} {
  switch (response.actionIdentifier) {
    case "useful":
    case "not_useful":
      return { action: response.actionIdentifier };
    case "reply":
      return { action: "reply", replyText: response.userText ?? "" };
    default:
      return { action: "opened" };
  }
}
