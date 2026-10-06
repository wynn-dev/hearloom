import type { ConfigContext, ExpoConfig } from "expo/config";

/** Self-hosters: override with your own bundle id / team (push + signing are per Apple account). */
const bundleId = process.env.HEARLOOM_BUNDLE_ID ?? "me.weish.hearloom";
const appleTeamId = process.env.APPLE_TEAM_ID;

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "Hearloom",
  slug: "hearloom",
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
  experiments: { typedRoutes: true, reactCompiler: true },
});
