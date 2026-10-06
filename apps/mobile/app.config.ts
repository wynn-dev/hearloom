import type { ConfigContext, ExpoConfig } from "expo/config";

/** Self-hosters: override with your own bundle id / team (push + signing are per Apple account). */
const bundleId = process.env.HEARLOOM_BUNDLE_ID ?? "me.weish.hearloom";
const appleTeamId = process.env.APPLE_TEAM_ID;
/**
 * EAS project (cloud builds, TestFlight, over-the-air updates). Self-hosters with their own bundle id
 * get no EAS project (and no OTA updates) unless they set both of these to their own Expo account.
 */
const easOwner = process.env.HEARLOOM_EAS_OWNER ?? "unlaboredlabs";
const easProjectId =
  process.env.HEARLOOM_EAS_PROJECT_ID ??
  (bundleId === "me.weish.hearloom" ? "f4bb5502-b77b-4f58-b5b8-fdcc6548bfa1" : undefined);

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "Hearloom",
  slug: "hearloom",
  owner: easOwner,
  version: "0.1.0",
  scheme: "hearloom",
  orientation: "portrait",
  icon: "./assets/images/icon.png",
  userInterfaceStyle: "automatic",
  platforms: ["ios"],
  ios: {
    bundleIdentifier: bundleId,
    ...(appleTeamId ? { appleTeamId } : {}),
    supportsTablet: false,
    icon: "./assets/expo.icon",
    infoPlist: {
      NSBluetoothAlwaysUsageDescription:
        "Hearloom connects to your Omi pendant to record what it hears, even in the background.",
      UIBackgroundModes: ["bluetooth-central", "remote-notification"],
      NSAppTransportSecurity: {
        // Self-hosted servers are often reached over Tailscale (already encrypted by WireGuard).
        NSAllowsLocalNetworking: true,
        NSExceptionDomains: {
          "ts.net": { NSIncludesSubdomains: true, NSExceptionAllowsInsecureHTTPLoads: true },
        },
      },
      ITSAppUsesNonExemptEncryption: false,
    },
    entitlements: {
      "com.apple.developer.usernotifications.time-sensitive": true,
    },
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    ["expo-notifications", { mode: process.env.HEARLOOM_APS_ENV ?? "development" }],
    [
      "expo-splash-screen",
      { backgroundColor: "#0E1116", image: "./assets/images/splash-icon.png", imageWidth: 76 },
    ],
  ],
  // Updates only reach builds with the same native code (fingerprint), see .eas/workflows.
  runtimeVersion: { policy: "fingerprint" },
  ...(easProjectId
    ? {
        updates: { url: `https://u.expo.dev/${easProjectId}` },
        extra: { ...config.extra, eas: { projectId: easProjectId } },
      }
    : {}),
  experiments: { typedRoutes: true, reactCompiler: true },
});
