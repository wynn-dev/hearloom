import { QueryClientProvider } from "@tanstack/react-query";
import * as Notifications from "expo-notifications";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider, useRouter } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { useColorScheme } from "react-native";
import { notificationData } from "@/lib/push";
import { queryClient, SessionProvider, useSession } from "@/lib/session-context";

SplashScreen.preventAutoHideAsync();

/** Routes notification taps: tell the server it was opened and follow in-app deep links. */
function NotificationResponses() {
  const { state } = useSession();
  const router = useRouter();
  const last = Notifications.useLastNotificationResponse();
  useEffect(() => {
    if (!last || state.status !== "signedIn") return;
    const data = notificationData(last.notification);
    if (data.hlId) {
      void state.rpc.notifications.opened({ id: data.hlId }).catch(() => {});
      void queryClient.invalidateQueries();
    }
    if (data.deepLink?.startsWith("/")) {
      router.push(data.deepLink === "/" ? "/" : (data.deepLink as never));
    }
    void Notifications.clearLastNotificationResponseAsync();
  }, [last, state, router]);
  return null;
}

function Gate() {
  const { state } = useSession();
  const signedIn = state.status === "signedIn";
  useEffect(() => {
    if (state.status !== "loading") void SplashScreen.hideAsync();
  }, [state.status]);
  if (state.status === "loading") return null;
  return (
    <>
      <NotificationResponses />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Protected guard={signedIn}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen
            name="pair"
            options={{ presentation: "modal", headerShown: true, title: "Pair pendant" }}
          />
          <Stack.Screen
            name="logs"
            options={{ presentation: "modal", headerShown: true, title: "Capture log" }}
          />
        </Stack.Protected>
        <Stack.Protected guard={!signedIn}>
          <Stack.Screen name="login" />
        </Stack.Protected>
        {/* hearloom://link?server=…&code=… (a scanned "Link device" QR code), signed in or out. Also on
            a cold start: the navigation state is seeded from the launch URL while Gate is still loading. */}
        <Stack.Screen name="link" />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const scheme = useColorScheme();
  return (
    <ThemeProvider value={scheme === "dark" ? DarkTheme : DefaultTheme}>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <Gate />
        </SessionProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
