import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  type TextStyle,
  View,
  type ViewProps,
} from "react-native";
import { useTheme } from "@/lib/theme";

export function Card({ children, style }: { children: ReactNode; style?: ViewProps["style"] }) {
  const t = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: t.card, borderColor: t.border }, style]}>
      {children}
    </View>
  );
}

export function Title({ children }: { children: ReactNode }) {
  const t = useTheme();
  return <Text style={[styles.title, { color: t.text }]}>{children}</Text>;
}

export function Label({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  const t = useTheme();
  return <Text style={[styles.label, { color: t.muted }, style]}>{children}</Text>;
}

export function Body({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  const t = useTheme();
  return <Text style={[styles.body, { color: t.text }, style]}>{children}</Text>;
}

export function Row({
  label,
  value,
  right,
}: {
  label: string;
  value?: ReactNode;
  right?: ReactNode;
}) {
  const t = useTheme();
  return (
    <View style={[styles.row, { borderColor: t.border }]}>
      <Text style={[styles.body, { color: t.muted }]}>{label}</Text>
      {right ?? (
        <Text style={[styles.body, { color: t.text, flexShrink: 1, textAlign: "right" }]}>
          {value}
        </Text>
      )}
    </View>
  );
}

export function Button({
  title,
  onPress,
  kind = "primary",
  loading,
  disabled,
}: {
  title: string;
  onPress: () => void;
  kind?: "primary" | "secondary" | "danger";
  loading?: boolean;
  disabled?: boolean;
}) {
  const t = useTheme();
  const bg = kind === "primary" ? t.accent : kind === "danger" ? t.bad : t.chip;
  const fg = kind === "secondary" ? t.text : "#fff";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, opacity: disabled ? 0.4 : pressed ? 0.75 : 1 },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={[styles.buttonText, { color: fg }]}>{title}</Text>
      )}
    </Pressable>
  );
}

export function Pill({
  text,
  tone = "neutral",
}: {
  text: string;
  tone?: "neutral" | "good" | "warn" | "bad";
}) {
  const t = useTheme();
  const color =
    tone === "good" ? t.good : tone === "warn" ? t.warn : tone === "bad" ? t.bad : t.muted;
  return (
    <View style={[styles.pill, { backgroundColor: t.chip }]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.pillText, { color: t.text }]}>{text}</Text>
    </View>
  );
}

export const styles = StyleSheet.create({
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 16, gap: 10 },
  title: { fontSize: 17, fontWeight: "600" },
  label: { fontSize: 13, fontWeight: "500", textTransform: "uppercase", letterSpacing: 0.4 },
  body: { fontSize: 15 },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    paddingVertical: 6,
  },
  button: { borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16, alignItems: "center" },
  buttonText: { fontSize: 16, fontWeight: "600" },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  pillText: { fontSize: 13, fontWeight: "500" },
  screen: { padding: 16, gap: 16 },
});
