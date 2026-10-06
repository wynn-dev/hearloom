import { OmiCapture } from "omi-capture";
import { useState } from "react";
import { ScrollView, Text } from "react-native";
import { useTheme } from "@/lib/theme";

/** Newest-first snapshot of the native capture log. Keys stay unique when lines repeat. */
function snapshot(): { key: string; line: string }[] {
  const seen = new Map<string, number>();
  return OmiCapture.getLogs()
    .slice()
    .reverse()
    .map((line) => {
      const n = (seen.get(line) ?? 0) + 1;
      seen.set(line, n);
      return { key: `${line}|${n}`, line };
    });
}

export default function Logs() {
  const t = useTheme();
  const [lines] = useState(snapshot);
  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ padding: 12 }}>
      {lines.map(({ key, line }) => (
        <Text
          key={key}
          style={{ color: t.text, fontFamily: "Menlo", fontSize: 11, marginBottom: 4 }}
          selectable
        >
          {line}
        </Text>
      ))}
    </ScrollView>
  );
}
