import type { NotificationItem } from "@hearloom/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import { useCallback } from "react";
import { FlatList, RefreshControl, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Body, Button, Card, Pill } from "@/components/ui";
import { timeAgo } from "@/lib/capture";
import { useSignedIn } from "@/lib/session-context";
import { useTheme } from "@/lib/theme";

const STATUS_TONE: Record<NotificationItem["status"], "good" | "warn" | "bad" | "neutral"> = {
  delivered: "good",
  sent: "good",
  pending: "neutral",
  suppressed: "neutral",
  failed: "bad",
};

export default function Notifications() {
  const t = useTheme();
  const { orpc, rpc } = useSignedIn();
  const qc = useQueryClient();
  const q = useQuery(orpc.notifications.list.queryOptions({ input: { limit: 50 } }));
  useFocusEffect(
    useCallback(() => {
      void q.refetch();
    }, [q.refetch]),
  );
  const test = useMutation({
    mutationFn: () => rpc.notifications.sendTest({}),
    onSuccess: () => qc.invalidateQueries({ queryKey: orpc.notifications.key() }),
  });

  return (
    <SafeAreaView edges={["top"]} style={{ flex: 1, backgroundColor: t.bg }}>
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        data={q.data ?? []}
        keyExtractor={(n) => n.id}
        contentContainerStyle={{ padding: 16, gap: 12 }}
        refreshControl={
          <RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} />
        }
        ListHeaderComponent={
          <View style={{ gap: 12 }}>
            <Text style={{ fontSize: 30, fontWeight: "700", color: t.text }}>Inbox</Text>
            <Button
              title="Send test notification"
              kind="secondary"
              loading={test.isPending}
              onPress={() => test.mutate()}
            />
          </View>
        }
        ListEmptyComponent={
          <Body style={{ color: t.muted }}>
            {q.isLoading ? "Loading…" : "No notifications yet."}
          </Body>
        }
        renderItem={({ item: n }) => (
          <Card>
            <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
              <Text style={{ color: t.text, fontWeight: "600", fontSize: 16, flex: 1 }}>
                {n.title}
              </Text>
              <Pill
                text={
                  n.statusReason ? `${n.status} · ${n.statusReason.replaceAll("_", " ")}` : n.status
                }
                tone={STATUS_TONE[n.status]}
              />
            </View>
            <Body>{n.body}</Body>
            <Text style={{ color: t.muted, fontSize: 12 }}>
              {n.source} · {n.category} · {timeAgo(n.createdAt.getTime())}
            </Text>
          </Card>
        )}
      />
    </SafeAreaView>
  );
}
