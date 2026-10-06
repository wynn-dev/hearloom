import { useRouter } from "expo-router";
import { OmiCapture } from "omi-capture";
import { ActivityIndicator, FlatList, Pressable, Text, View } from "react-native";
import { Body } from "@/components/ui";
import { BLE_LABEL, useCaptureStatus, useDiscoveredDevices } from "@/lib/capture";
import { useTheme } from "@/lib/theme";

export default function Pair() {
  const t = useTheme();
  const router = useRouter();
  const status = useCaptureStatus();
  const devices = useDiscoveredDevices(true);

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, padding: 16, gap: 12 }}>
      <Body style={{ color: t.muted }}>
        Keep the pendant close and awake. Only Omi devices advertising the audio service are listed.
      </Body>
      {status.ble === "poweredOff" || status.ble === "unauthorized" ? (
        <Text style={{ color: t.bad }}>{BLE_LABEL[status.ble]}</Text>
      ) : null}
      <FlatList
        data={devices}
        keyExtractor={(d) => d.id}
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        ListEmptyComponent={
          <View style={{ alignItems: "center", padding: 32, gap: 8 }}>
            <ActivityIndicator />
            <Body style={{ color: t.muted }}>Searching…</Body>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => {
              OmiCapture.pair(item.id);
              router.back();
            }}
            style={({ pressed }) => ({
              padding: 16,
              borderRadius: 12,
              backgroundColor: t.card,
              opacity: pressed ? 0.7 : 1,
              flexDirection: "row",
              justifyContent: "space-between",
            })}
          >
            <Text style={{ color: t.text, fontSize: 17, fontWeight: "600" }}>{item.name}</Text>
            <Text style={{ color: t.muted }}>{item.rssi} dBm</Text>
          </Pressable>
        )}
      />
    </View>
  );
}
