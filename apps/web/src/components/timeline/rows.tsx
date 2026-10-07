import type { AudioChunk } from "@hearloom/api";
import {
  EPISODE_KIND_DESCRIPTION,
  EPISODE_KIND_LABEL,
  type EpisodeKind,
  KNOWN_EPISODE_KINDS,
  type KnownEpisodeKind,
} from "@hearloom/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AudioLines,
  BatteryCharging,
  BatteryMedium,
  Bluetooth,
  BluetoothOff,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Download,
  Flag,
  Hand,
  MessagesSquare,
  Mic,
  MicOff,
  Music,
  Pencil,
  Play,
  Presentation,
  Scissors,
  Tv,
  User,
  Users,
  Waves,
} from "lucide-react";
import {
  createContext,
  memo,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/cn";
import { errorMessage, orpc } from "../../lib/orpc";
import { formatBytes, formatDuration, formatTime } from "../../lib/time";
import { IdentifySpeaker } from "../speakers";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Field, Input, Select, Textarea } from "../ui/input";
import { useToast } from "../ui/toast";
import {
  type Bookmark,
  type DeviceEvent,
  deviceEventText,
  type Entry,
  type Episode,
  type SoundEvent,
  type Utterance,
} from "./model";

/** What rows need to know about the day's episodes. */
export interface TimelineActions {
  episode(id: string): Episode | undefined;
  /** The episode right before this one (for merging), if any. */
  previous(id: string): Episode | undefined;
  /** The sound heard longest during an episode ("music"), for sound episodes. */
  soundOf(id: string): string | undefined;
  toggleFold(id: string): void;
  folded(id: string): boolean;
}

const Actions = createContext<TimelineActions | null>(null);
export const TimelineActionsProvider = Actions.Provider;

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

const UtteranceRow = memo(function UtteranceRow({
  item,
  tz,
  ep,
}: {
  item: Utterance;
  tz: string;
  ep: string | null;
}) {
  return (
    <Line
      at={item.startAt}
      tz={tz}
      icon={<span className="size-1.5 rounded-full bg-line-strong" />}
    >
      <div className="group flex flex-wrap items-center gap-1.5">
        <span
          className={cn("text-xs font-semibold", item.isWearer ? "text-accent-ink" : "text-ink-2")}
        >
          {speakerOf(item)}
        </span>
        <IdentifySpeaker
          utteranceId={item.id}
          known={item.personId !== null}
          shortClip={item.endAt.getTime() - item.startAt.getTime() < 1000}
        />
        {item.lang ? <Badge className="uppercase">{item.lang}</Badge> : null}
        {item.mediaVoice ? (
          <Badge tone="info" title="This voice also speaks on the TV or radio in this stretch">
            TV
          </Badge>
        ) : null}
        <Badge tone={item.source === "refine" ? "good" : "neutral"}>
          {item.source === "refine" ? "refined" : "live"}
        </Badge>
        {ep ? <SplitHere episodeId={ep} at={item.startAt} tz={tz} /> : null}
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

const KIND_ICON: Record<EpisodeKind, ReactNode> = {
  conversation: <MessagesSquare />,
  talk: <Presentation />,
  media: <Tv />,
  ambient: <Users />,
  solo: <User />,
  sound: <Music />,
  unknown: <AudioLines />,
};

function useEpisodeEdit<T>(
  mutate: (input: T) => Promise<unknown>,
  failure: string,
  onDone?: () => void,
) {
  const toast = useToast();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: mutate,
    onSuccess: () => {
      onDone?.();
      void queryClient.invalidateQueries({ queryKey: orpc.timeline.key() });
    },
    onError: (err) => toast({ tone: "bad", title: failure, description: errorMessage(err) }),
  });
}

/** Rename, describe, re-classify, or merge with the episode before. */
function EditEpisode({ item, tz }: { item: Episode; tz: string }) {
  const actions = useContext(Actions);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(item.title ?? "");
  const [summary, setSummary] = useState(item.summary ?? "");
  const [kind, setKind] = useState<KnownEpisodeKind | "">(item.kind === "unknown" ? "" : item.kind);
  const ids = { title: useId(), kind: useId(), summary: useId() };
  const close = () => setOpen(false);
  const update = useEpisodeEdit(
    (input: Parameters<typeof orpc.episodes.update.call>[0]) => orpc.episodes.update.call(input),
    "Couldn't save the episode",
    close,
  );
  const merge = useEpisodeEdit(
    (ids: [string, string]) => orpc.episodes.merge.call({ ids }),
    "Couldn't merge",
    close,
  );
  const prev = actions?.previous(item.id);
  const canMerge = !!prev?.endedAt && !!item.endedAt;

  const save = () =>
    update.mutate({
      id: item.id,
      ...(title !== (item.title ?? "") ? { title: title.trim() || null } : {}),
      ...(summary !== (item.summary ?? "") ? { summary: summary.trim() || null } : {}),
      ...(kind && kind !== item.kind ? { kind } : {}),
    });

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setTitle(item.title ?? "");
          setSummary(item.summary ?? "");
          setKind(item.kind === "unknown" ? "" : item.kind);
          setOpen(true);
        }}
        className="inline-flex cursor-pointer items-center gap-1 rounded px-1 text-[11px] text-ink-3 hover:text-ink"
        title="Rename or re-classify"
      >
        <Pencil className="size-3" aria-hidden />
        Edit
      </button>
      <Dialog
        open={open}
        onClose={close}
        title="Edit episode"
        description={`${formatTime(item.startedAt, tz)}–${item.endedAt ? formatTime(item.endedAt, tz) : "now"}. Your changes aren't undone by automatic segmentation or the agent.`}
        footer={
          <>
            {canMerge ? (
              <Button
                className="mr-auto"
                loading={merge.isPending}
                onClick={() => merge.mutate([prev!.id, item.id])}
                title={`Merge with the ${EPISODE_KIND_LABEL[prev!.kind].toLowerCase()} before it`}
              >
                Merge with previous
              </Button>
            ) : null}
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" loading={update.isPending} onClick={save}>
              Save
            </Button>
          </>
        }
      >
        <Field label="Title" htmlFor={ids.title}>
          <Input
            id={ids.title}
            value={title}
            maxLength={200}
            placeholder={EPISODE_KIND_LABEL[item.kind]}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field
          label="What was it?"
          htmlFor={ids.kind}
          hint={kind ? EPISODE_KIND_DESCRIPTION[kind] : "Not classified yet"}
        >
          <Select
            id={ids.kind}
            value={kind}
            onChange={(e) => setKind(e.target.value as KnownEpisodeKind)}
          >
            {kind === "" ? <option value="">Not classified yet</option> : null}
            {KNOWN_EPISODE_KINDS.map((k) => (
              <option key={k} value={k}>
                {EPISODE_KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Summary" htmlFor={ids.summary}>
          <Textarea
            id={ids.summary}
            value={summary}
            maxLength={4000}
            onChange={(e) => setSummary(e.target.value)}
          />
        </Field>
      </Dialog>
    </>
  );
}

/** "Split here": a new episode starts at this utterance (ended episodes only). */
function SplitHere({ episodeId, at, tz }: { episodeId: string; at: Date; tz: string }) {
  const actions = useContext(Actions);
  const split = useEpisodeEdit(
    (input: { id: string; at: Date }) => orpc.episodes.split.call(input),
    "Couldn't split",
  );
  const ep = actions?.episode(episodeId);
  if (!ep?.endedAt || at.getTime() <= ep.startedAt.getTime()) return null;
  return (
    <button
      type="button"
      onClick={() => split.mutate({ id: episodeId, at })}
      disabled={split.isPending}
      className="inline-flex cursor-pointer items-center gap-1 rounded px-1 text-[11px] text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 hover:text-ink focus-visible:opacity-100"
      title={`Start a new episode at ${formatTime(at, tz, true)}`}
    >
      <Scissors className="size-3" aria-hidden />
      Split here
    </button>
  );
}

const EpisodeHeader = memo(function EpisodeHeader({
  item,
  hidden,
  tz,
}: {
  item: Episode;
  hidden: number;
  tz: string;
}) {
  const actions = useContext(Actions);
  const end = item.endedAt;
  const folded = actions?.folded(item.id) ?? false;
  const kind = EPISODE_KIND_LABEL[item.kind];
  const sound = item.kind === "sound" ? actions?.soundOf(item.id) : undefined;
  const name = item.title ?? (sound ? sound[0]!.toUpperCase() + sound.slice(1) : kind);
  return (
    <div className="mt-3 mb-1 rounded-md bg-surface-2 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-series-2 [&_svg]:size-4" aria-hidden>
          {KIND_ICON[item.kind]}
        </span>
        <span className="text-[13px] font-semibold text-ink">{name}</span>
        {name !== kind ? <span className="text-xs text-ink-2">{kind}</span> : null}
        <span className="text-xs text-ink-3 tabular">
          {formatTime(item.startedAt, tz)}–{end ? formatTime(end, tz) : "now"}
          {end ? ` · ${formatDuration(end.getTime() - item.startedAt.getTime())}` : ""}
        </span>
        {!end ? (
          <Badge tone="good" dot>
            ongoing
          </Badge>
        ) : item.refined ? (
          <Badge tone="good">refined</Badge>
        ) : null}
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
        <span className="ml-auto flex items-center gap-1">
          {hidden > 0 ||
          (actions && !folded && (item.kind === "media" || item.kind === "ambient")) ? (
            <button
              type="button"
              aria-expanded={!folded}
              onClick={() => actions?.toggleFold(item.id)}
              className="inline-flex cursor-pointer items-center gap-0.5 rounded px-1 text-[11px] text-ink-3 hover:text-ink"
            >
              {folded ? (
                <ChevronRight className="size-3" aria-hidden />
              ) : (
                <ChevronDown className="size-3" aria-hidden />
              )}
              {folded ? `Show ${hidden} line${hidden === 1 ? "" : "s"}` : "Hide"}
            </button>
          ) : null}
          <EditEpisode item={item} tz={tz} />
        </span>
      </div>
      {item.summary ? <p className="mt-1 text-[13px] text-ink-2">{item.summary}</p> : null}
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
      return <UtteranceRow item={entry.item} tz={tz} ep={entry.ep} />;
    case "sound":
      return <SoundRow item={entry.item} tz={tz} />;
    case "bookmark":
      return <BookmarkRow item={entry.item} tz={tz} />;
    case "device":
      return <DeviceRow item={entry.item} tz={tz} />;
    case "episode":
      return <EpisodeHeader item={entry.item} hidden={entry.hidden} tz={tz} />;
    case "gap":
      return <GapRow ms={entry.ms} />;
  }
}

/** One list entry. Rows inside an episode get an indented rule so the group reads as one. */
export function EntryView({ entry, tz }: { entry: Entry; tz: string }) {
  const grouped = entry.ep !== null && entry.kind !== "episode";
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
