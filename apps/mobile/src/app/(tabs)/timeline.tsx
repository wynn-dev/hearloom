import type { Episode, Timeline as TimelineData } from "@hearloom/api";
import { EPISODE_KIND_LABEL } from "@hearloom/shared";
import { useQuery } from "@tanstack/react-query";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useMemo, useState } from "react";
import { Pressable, RefreshControl, SectionList, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Body, Pill } from "@/components/ui";
import { formatDuration } from "@/lib/capture";
import { useSignedIn } from "@/lib/session-context";
import { useTheme } from "@/lib/theme";

type Item =
  | { kind: "utterance"; at: Date; u: TimelineData["utterances"][number] }
  | { kind: "sound"; at: Date; s: TimelineData["soundEvents"][number] }
  | { kind: "bookmark"; at: Date; b: TimelineData["bookmarks"][number] }
  | { kind: "chunk"; at: Date; c: TimelineData["chunks"][number] }
  | { kind: "device"; at: Date; e: TimelineData["deviceEvents"][number] };

const DEVICE_LABEL: Record<string, string> = {
  wearable_connected: "Pendant connected",
  wearable_disconnected: "Pendant disconnected",
  muted: "Muted",
  unmuted: "Unmuted",
};

function dayRange(offset: number): { from: Date; to: Date; label: string } {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() + offset);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  const label =
    offset === 0
      ? "Today"
      : offset === -1
        ? "Yesterday"
        : from.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  return { from, to, label };
}

const hhmm = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** Speech that isn't the user's (TV, people nearby) starts folded. */
const foldedByDefault = (e: Episode) => e.kind === "media" || e.kind === "ambient";

function episodeTitle(e: Episode): string {
  const kind = EPISODE_KIND_LABEL[e.kind];
  const span = `${hhmm(e.startedAt)}–${e.endedAt ? hhmm(e.endedAt) : "now"}`;
  return `${span} · ${e.title ? `${e.title} (${kind.toLowerCase()})` : kind}`;
}

interface Section {
  key: string;
  title: string;
  episode?: Episode;
  /** Lines folded away (media / ambient episodes). */
  hidden: number;
  data: Item[];
}

export default function Timeline() {
  const t = useTheme();
  const { orpc, session } = useSignedIn();
  const [offset, setOffset] = useState(0);
  const range = useMemo(() => dayRange(offset), [offset]);
  const q = useQuery({
    ...orpc.timeline.range.queryOptions({ input: { from: range.from, to: range.to } }),
    refetchInterval: offset === 0 ? 20_000 : false,
  });
  const player = useAudioPlayer(null);
  const playback = useAudioPlayerStatus(player);
  const [playing, setPlaying] = useState<string | null>(null);
  const [foldOverride, setFoldOverride] = useState<ReadonlyMap<string, boolean>>(new Map());

  const sections = useMemo((): Section[] => {
    const d = q.data;
    if (!d) return [];
    const folded = (e: Episode) => foldOverride.get(e.id) ?? foldedByDefault(e);
    const items: Item[] = [
      ...d.utterances.map((u) => ({ kind: "utterance" as const, at: u.startAt, u })),
      ...d.soundEvents.map((s) => ({ kind: "sound" as const, at: s.startAt, s })),
      ...d.bookmarks.map((b) => ({ kind: "bookmark" as const, at: b.at, b })),
      ...d.deviceEvents
        .filter((e) => e.kind in DEVICE_LABEL)
        .map((e) => ({ kind: "device" as const, at: e.at, e })),
      // Audio chunks only stand on their own when there's no transcript yet.
      ...(d.utterances.length === 0
        ? d.chunks.map((c) => ({ kind: "chunk" as const, at: c.startAt, c }))
        : []),
    ].sort((a, b) => b.at.getTime() - a.at.getTime());
    // Newest first: one section per episode, and per hour for what happened outside episodes.
    const episodeAt = (at: Date) =>
      d.episodes.find((e) => e.startedAt <= at && (e.endedAt === null || at < e.endedAt));
    const out = new Map<string, Section>();
    for (const it of items) {
      const ep = episodeAt(it.at);
      let key: string;
      let title: string;
      if (ep) {
        key = `e:${ep.id}`;
        title = episodeTitle(ep);
      } else {
        const h = new Date(it.at);
        h.setMinutes(0, 0, 0);
        title = hhmm(h);
        key = `h:${title}`;
      }
      const section = out.get(key) ?? { key, title, episode: ep, hidden: 0, data: [] };
      out.set(key, section);
      if (ep && folded(ep)) section.hidden++;
      else section.data.push(it);
    }
    return [...out.values()];
  }, [q.data, foldOverride]);

  const toggleFold = (e: Episode) =>
    setFoldOverride((m) => new Map(m).set(e.id, !(m.get(e.id) ?? foldedByDefault(e))));

  const play = (id: string, url: string) => {
    if (playing === id && playback.playing) {
      player.pause();
      return;
    }
    player.replace({ uri: `${session.serverURL}${url}` });
    player.play();
    setPlaying(id);
  };

  const recorded = q.data?.chunks.reduce((n, c) => n + c.durationMs, 0) ?? 0;

  return (
    <SafeAreaView edges={["top"]} style={{ flex: 1, backgroundColor: t.bg }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          padding: 16,
        }}
      >
        <Pressable onPress={() => setOffset((o) => o - 1)} hitSlop={12}>
          <Text style={{ color: t.accent, fontSize: 22 }}>‹</Text>
        </Pressable>
        <View style={{ alignItems: "center" }}>
          <Text style={{ color: t.text, fontSize: 20, fontWeight: "700" }}>{range.label}</Text>
          <Text style={{ color: t.muted, fontSize: 13 }}>{formatDuration(recorded)} recorded</Text>
        </View>
        <Pressable
          onPress={() => setOffset((o) => Math.min(0, o + 1))}
          hitSlop={12}
          disabled={offset === 0}
        >
          <Text style={{ color: offset === 0 ? t.border : t.accent, fontSize: 22 }}>›</Text>
        </Pressable>
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(it) =>
          `${it.kind}-${"u" in it ? it.u.id : "s" in it ? it.s.id : "b" in it ? it.b.id : "c" in it ? it.c.id : it.e.id}`
        }
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
        refreshControl={
          <RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} />
        }
        stickySectionHeadersEnabled
        renderSectionHeader={({ section }) => {
          const ep = section.episode;
          const canFold = ep && (section.hidden > 0 || foldedByDefault(ep));
          return (
            <View
              style={{
                backgroundColor: t.bg,
                paddingVertical: 6,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <Text style={{ color: ep ? t.text : t.muted, fontWeight: "600", flexShrink: 1 }}>
                {section.title}
              </Text>
              {canFold ? (
                <Pressable onPress={() => toggleFold(ep)} hitSlop={8}>
                  <Text style={{ color: t.accent, fontSize: 13 }}>
                    {section.hidden > 0
                      ? `Show ${section.hidden} line${section.hidden === 1 ? "" : "s"}`
                      : "Hide"}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          );
        }}
        ListEmptyComponent={
          <Body style={{ color: t.muted, textAlign: "center", marginTop: 48 }}>
            {q.isLoading
              ? "Loading…"
              : q.isError
                ? "Couldn't load the timeline."
                : "Nothing recorded this day."}
          </Body>
        }
        renderItem={({ item }) => {
          const time = (
            <Text style={{ color: t.muted, fontSize: 12, width: 44 }}>{hhmm(item.at)}</Text>
          );
          switch (item.kind) {
            case "utterance": {
              const who =
                item.u.personName ?? (item.u.isWearer ? "Me" : (item.u.speakerKey ?? "Someone"));
              return (
                <View style={{ flexDirection: "row", gap: 8, paddingVertical: 6 }}>
                  {time}
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: t.accent, fontWeight: "600", fontSize: 13 }}>{who}</Text>
                    <Text style={{ color: t.text, fontSize: 15 }}>{item.u.text}</Text>
                  </View>
                </View>
              );
            }
            case "sound":
              return (
                <View
                  style={{ flexDirection: "row", gap: 8, paddingVertical: 4, alignItems: "center" }}
                >
                  {time}
                  <Pill text={item.s.label} />
                </View>
              );
            case "bookmark":
              return (
                <View style={{ flexDirection: "row", gap: 8, paddingVertical: 4 }}>
                  {time}
                  <Text style={{ color: t.warn, fontWeight: "600" }}>
                    ⚑ Bookmark{item.b.note ? ` — ${item.b.note}` : ""}
                  </Text>
                </View>
              );
            case "device":
              return (
                <View style={{ flexDirection: "row", gap: 8, paddingVertical: 2 }}>
                  {time}
                  <Text style={{ color: t.muted, fontSize: 13 }}>{DEVICE_LABEL[item.e.kind]}</Text>
                </View>
              );
            case "chunk": {
              const active = playing === item.c.id && playback.playing;
              return (
                <Pressable
                  onPress={() => play(item.c.id, item.c.url)}
                  style={{ flexDirection: "row", gap: 8, paddingVertical: 6, alignItems: "center" }}
                >
                  {time}
                  <Text style={{ color: t.accent, fontSize: 15 }}>{active ? "❚❚" : "▶"}</Text>
                  <Text style={{ color: t.text }}>Audio · {formatDuration(item.c.durationMs)}</Text>
                </Pressable>
              );
            }
          }
        }}
      />
    </SafeAreaView>
  );
}
