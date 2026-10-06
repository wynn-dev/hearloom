import type { AudioChunk } from "@hearloom/api";
import {
  AudioLines,
  BatteryCharging,
  BatteryMedium,
  Bluetooth,
  BluetoothOff,
  CircleDot,
  Download,
  Flag,
  Hand,
  MessagesSquare,
  Mic,
  MicOff,
  Play,
  Waves,
} from "lucide-react";
import { memo, type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { formatBytes, formatDuration, formatTime } from "../../lib/time";
import { Badge } from "../ui/badge";
import {
  type Bookmark,
  type Conversation,
  type DeviceEvent,
  deviceEventText,
  type Entry,
  type SoundEvent,
  type Utterance,
} from "./model";

/** Shared row grid: time | icon | content. */
function Line({
  at,
  tz,
  icon,
  children,
  className,
}: {
  at: Date;
  tz: string;
  icon: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid grid-cols-[4.75rem_1.25rem_minmax(0,1fr)] gap-x-2 py-1.5", className)}>
      <time
        dateTime={at.toISOString()}
        className="pt-px text-xs leading-5 text-ink-3 tabular whitespace-nowrap"
      >
        {formatTime(at, tz, true)}
      </time>
      <span className="flex h-5 items-center justify-center text-ink-3 [&_svg]:size-3.5">
        {icon}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

const sameChunks = (a: AudioChunk[], b: AudioChunk[]) =>
  a.length === b.length && a.every((c, i) => c === b[i]);

/** A run of contiguous audio chunks with one player that advances clip by clip. */
const AudioRunRow = memo(
  function AudioRunRow({ chunks, tz }: { chunks: AudioChunk[]; tz: string }) {
    const [index, setIndex] = useState(0);
    const [showClips, setShowClips] = useState(false);
    const audio = useRef<HTMLAudioElement>(null);
    const autoplay = useRef(false);
    const current = Math.min(index, chunks.length - 1);
    const chunk = chunks[current]!;
    const first = chunks[0]!;
    const last = chunks[chunks.length - 1]!;
    const total = chunks.reduce((sum, c) => sum + c.durationMs, 0);

    // biome-ignore lint/correctness/useExhaustiveDependencies: play after the clip index changes
    useEffect(() => {
      if (!autoplay.current) return;
      autoplay.current = false;
      audio.current?.play().catch(() => {});
    }, [current]);

    const playClip = (i: number) => {
      if (i === current) {
        audio.current?.play().catch(() => {});
        return;
      }
      autoplay.current = true;
      setIndex(i);
    };

    return (
      <Line at={first.startAt} tz={tz} icon={<AudioLines className="text-series-1" />}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
          <span className="font-medium text-ink">Audio</span>
          <span className="text-xs text-ink-3 tabular">
            until {formatTime(last.endAt, tz, true)} · {formatDuration(total)}
          </span>
          {chunks.length > 1 ? (
            <button
              type="button"
              aria-expanded={showClips}
              onClick={() => setShowClips((v) => !v)}
              className="cursor-pointer text-xs text-accent-ink hover:underline"
            >
              {showClips ? "Hide" : "Show"} {chunks.length} clips
            </button>
          ) : null}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          {/* biome-ignore lint/a11y/useMediaCaption: raw recordings; transcripts render as rows */}
          <audio
            ref={audio}
            controls
            preload="none"
            src={chunk.url}
            className="w-full max-w-md"
            onEnded={() => {
              if (current < chunks.length - 1) playClip(current + 1);
            }}
          />
          {chunks.length > 1 ? (
            <span className="text-xs text-ink-3 tabular">
              clip {current + 1}/{chunks.length} · {formatTime(chunk.startAt, tz, true)}
            </span>
          ) : null}
        </div>
        {showClips ? (
          <ol className="mt-2 max-h-72 overflow-y-auto rounded-md border border-line text-xs">
            {chunks.map((c, i) => (
              <li
                key={c.id}
                className={cn(
                  "flex items-center gap-3 border-b border-line px-2.5 py-1 last:border-b-0",
                  i === current && "bg-accent-soft",
                )}
              >
                <button
                  type="button"
                  onClick={() => playClip(i)}
                  aria-label={`Play clip at ${formatTime(c.startAt, tz, true)}`}
                  className="cursor-pointer rounded p-0.5 text-ink-2 hover:bg-surface-2 hover:text-ink"
                >
                  <Play className="size-3" aria-hidden />
                </button>
                <span className="text-ink-2 tabular">{formatTime(c.startAt, tz, true)}</span>
                <span className="text-ink-3 tabular">{formatDuration(c.durationMs)}</span>
                <span className="text-ink-3 tabular">{formatBytes(c.byteSize)}</span>
                <a
                  href={c.url}
                  download
                  className="ml-auto text-ink-3 hover:text-ink"
                  aria-label="Download clip"
                >
                  <Download className="size-3.5" aria-hidden />
                </a>
              </li>
            ))}
          </ol>
        ) : null}
      </Line>
    );
  },
  (a, b) => a.tz === b.tz && sameChunks(a.chunks, b.chunks),
);

function speakerOf(u: Utterance): string {
  return u.personName ?? (u.isWearer ? "Me" : (u.speakerKey ?? "Unknown speaker"));
}

const UtteranceRow = memo(function UtteranceRow({ item, tz }: { item: Utterance; tz: string }) {
  return (
    <Line
      at={item.startAt}
      tz={tz}
      icon={<span className="size-1.5 rounded-full bg-line-strong" />}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={cn("text-xs font-semibold", item.isWearer ? "text-accent-ink" : "text-ink-2")}
        >
          {speakerOf(item)}
        </span>
        {item.lang ? <Badge className="uppercase">{item.lang}</Badge> : null}
        <Badge tone={item.source === "refine" ? "good" : "neutral"}>
          {item.source === "refine" ? "refined" : "live"}
        </Badge>
      </div>
      <p className="text-[13px] leading-relaxed text-ink">{item.text}</p>
    </Line>
  );
});

const SoundRow = memo(function SoundRow({ item, tz }: { item: SoundEvent; tz: string }) {
  const duration = item.endAt.getTime() - item.startAt.getTime();
  return (
    <Line at={item.startAt} tz={tz} icon={<Waves />}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
        <Badge tone="info">{item.label}</Badge>
        {item.kind === "state" ? (
          <span className="tabular">
            until {formatTime(item.endAt, tz, true)} · {formatDuration(duration)}
          </span>
        ) : (
          <span>moment</span>
        )}
        <span className="tabular">{Math.round(item.confidence * 100)}%</span>
      </div>
    </Line>
  );
});

const bookmarkSource: Record<Bookmark["source"], string> = {
  button: "pendant button",
  app: "phone",
  web: "console",
};

const BookmarkRow = memo(function BookmarkRow({ item, tz }: { item: Bookmark; tz: string }) {
  return (
    <Line at={item.at} tz={tz} icon={<Flag className="fill-series-3 text-series-3" />}>
      <p className="text-[13px] leading-5">
        <span className="font-medium text-ink">Bookmark</span>
        <span className="ml-2 text-xs text-ink-3">from {bookmarkSource[item.source]}</span>
      </p>
      {item.note ? <p className="text-[13px] text-ink-2">{item.note}</p> : null}
    </Line>
  );
});

function deviceIcon(e: DeviceEvent): ReactNode {
  switch (e.kind) {
    case "wearable_connected":
      return <Bluetooth />;
    case "wearable_disconnected":
      return <BluetoothOff />;
    case "battery":
      return <BatteryMedium />;
    case "charging":
      return <BatteryCharging />;
    case "muted":
      return <MicOff />;
    case "unmuted":
      return <Mic />;
    case "ack_nudge":
    case "button":
      return <Hand />;
    default:
      return <CircleDot />;
  }
}

const DeviceRow = memo(function DeviceRow({ item, tz }: { item: DeviceEvent; tz: string }) {
  return (
    <Line at={item.at} tz={tz} icon={deviceIcon(item)} className="py-1">
      <p className="text-xs leading-5 text-ink-3">{deviceEventText(item)}</p>
    </Line>
  );
});

const convStatus: Record<
  Conversation["status"],
  { label: string; tone: "good" | "neutral" | "info" }
> = {
  open: { label: "ongoing", tone: "good" },
  closed: { label: "closed", tone: "neutral" },
  refining: { label: "refining", tone: "info" },
  refined: { label: "refined", tone: "good" },
};

const ConversationHeader = memo(function ConversationHeader({
  item,
  tz,
}: {
  item: Conversation;
  tz: string;
}) {
  const status = convStatus[item.status];
  const end = item.endedAt;
  return (
    <div className="mt-3 mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-surface-2 px-3 py-2">
      <MessagesSquare className="size-4 text-series-2" aria-hidden />
      <span className="text-[13px] font-semibold text-ink">{item.title ?? "Conversation"}</span>
      <span className="text-xs text-ink-3 tabular">
        {formatTime(item.startedAt, tz)}–{end ? formatTime(end, tz) : "now"}
        {end ? ` · ${formatDuration(end.getTime() - item.startedAt.getTime())}` : ""}
      </span>
      <Badge tone={status.tone} dot={item.status === "open"}>
        {status.label}
      </Badge>
      {item.speakerCount > 0 ? (
        <span className="text-xs text-ink-3">
          {item.speakerCount} speaker{item.speakerCount === 1 ? "" : "s"}
        </span>
      ) : null}
      {item.languages.map((lang) => (
        <Badge key={lang} className="uppercase">
          {lang}
        </Badge>
      ))}
    </div>
  );
});

function GapRow({ ms }: { ms: number }) {
  return (
    <div className="flex items-center gap-3 py-2 text-[11px] text-ink-3" aria-hidden>
      <span className="h-px flex-1 bg-line" />
      {formatDuration(ms)} gap
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

function EntryBody({ entry, tz }: { entry: Entry; tz: string }) {
  switch (entry.kind) {
    case "audio":
      return <AudioRunRow chunks={entry.chunks} tz={tz} />;
    case "utterance":
      return <UtteranceRow item={entry.item} tz={tz} />;
    case "sound":
      return <SoundRow item={entry.item} tz={tz} />;
    case "bookmark":
      return <BookmarkRow item={entry.item} tz={tz} />;
    case "device":
      return <DeviceRow item={entry.item} tz={tz} />;
    case "conversation":
      return <ConversationHeader item={entry.item} tz={tz} />;
    case "gap":
      return <GapRow ms={entry.ms} />;
  }
}

/** One list entry. Rows inside a conversation get an indented rule so the group reads as one. */
export function EntryView({ entry, tz }: { entry: Entry; tz: string }) {
  const grouped = entry.conv !== null && entry.kind !== "conversation";
  return (
    <li
      id={`e-${entry.key}`}
      className={cn(
        "cv-auto scroll-mt-24 rounded-sm px-1",
        grouped && "ml-2 border-l-2 border-series-2/35 pl-2.5",
      )}
    >
      <EntryBody entry={entry} tz={tz} />
    </li>
  );
}
