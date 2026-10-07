import type { Timeline } from "@hearloom/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CalendarX2, ChevronLeft, ChevronRight, FileAudio, Flag, Info } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Stat } from "../../components/bits";
import { DayStrip } from "../../components/timeline/day-strip";
import {
  buildEntries,
  defaultFilters,
  type Episode,
  entryIndexAt,
  type Filters,
  foldedByDefault,
  visibleDeviceEvents,
} from "../../components/timeline/model";
import {
  EntryView,
  type TimelineActions,
  TimelineActionsProvider,
} from "../../components/timeline/rows";
import { Button, buttonClass } from "../../components/ui/button";
import { Card, PageHeader } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { EmptyState, ErrorNotice, LoadingRows, Spinner } from "../../components/ui/misc";
import { useToast } from "../../components/ui/toast";
import { cn } from "../../lib/cn";
import { useTimeZone } from "../../lib/me";
import { errorMessage, orpc } from "../../lib/orpc";
import { shareDeep } from "../../lib/query";
import {
  browserTimeZone,
  DAY_RE,
  dayInZone,
  dayRange,
  formatDayLabel,
  formatDuration,
  formatTime,
  shiftDay,
  useNow,
} from "../../lib/time";

export const Route = createFileRoute("/_app/timeline")({
  validateSearch: (search: Record<string, unknown>): { day?: string } =>
    typeof search.day === "string" && DAY_RE.test(search.day) ? { day: search.day } : {},
  component: TimelinePage,
});

function urlExpiry(url: string): number {
  return Number(new URL(url, location.origin).searchParams.get("exp")) || 0;
}

/**
 * Chunk URLs are re-signed on every fetch. Keep the URL we already have while it is still valid
 * for a while, so refetches (realtime invalidations) don't reload players or re-render rows.
 */
function shareTimeline(prev: unknown, next: unknown): unknown {
  const before = prev as Timeline | undefined;
  const after = next as Timeline;
  if (!before) return after;
  const known = new Map(before.chunks.map((c) => [c.id, c.url]));
  const minExpiry = Date.now() / 1000 + 30 * 60;
  let changed = false;
  const chunks = after.chunks.map((c) => {
    const url = known.get(c.id);
    if (url && url !== c.url && urlExpiry(url) > minExpiry) {
      changed = true;
      return { ...c, url };
    }
    return c;
  });
  return shareDeep(before, changed ? { ...after, chunks } : after);
}

const FILTERS_KEY = "hearloom:timeline-filters";

function useFilters(): [Filters, (key: keyof Filters) => void] {
  const [filters, setFilters] = useState<Filters>(() => {
    try {
      return { ...defaultFilters, ...JSON.parse(localStorage.getItem(FILTERS_KEY) ?? "{}") };
    } catch {
      return defaultFilters;
    }
  });
  const toggle = useCallback((key: keyof Filters) => {
    setFilters((current) => {
      const next = { ...current, [key]: !current[key] };
      localStorage.setItem(FILTERS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  return [filters, toggle];
}

function TimelinePage() {
  const tz = useTimeZone();
  if (!tz) {
    return (
      <div className="flex justify-center py-20 text-ink-3">
        <Spinner className="size-5" />
      </div>
    );
  }
  return <DayView tz={tz} />;
}

function DayView({ tz }: { tz: string }) {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const now = useNow(60_000);
  const today = dayInZone(now, tz);
  const day = search.day ?? today;
  const isToday = day === today;
  const range = useMemo(() => dayRange(day, tz), [day, tz]);
  const [filters, toggleFilter] = useFilters();

  const timeline = useQuery({
    ...orpc.timeline.range.queryOptions({ input: range }),
    structuralSharing: shareTimeline,
  });
  const data = timeline.data;
  // Media and ambient episodes start folded; the user can open (or fold) any episode.
  const [foldOverride, setFoldOverride] = useState<ReadonlyMap<string, boolean>>(new Map());
  const folded = useCallback(
    (ep: Episode) => foldOverride.get(ep.id) ?? foldedByDefault(ep),
    [foldOverride],
  );
  const entries = useMemo(
    () => (data ? buildEntries(data, filters, folded) : []),
    [data, filters, folded],
  );
  const actions = useMemo((): TimelineActions => {
    const eps = [...(data?.episodes ?? [])].sort(
      (a, b) => a.startedAt.getTime() - b.startedAt.getTime(),
    );
    const byId = new Map(eps.map((e, i) => [e.id, i]));
    return {
      episode: (id) => eps[byId.get(id) ?? -1],
      previous: (id) => eps[(byId.get(id) ?? 0) - 1],
      folded: (id) => {
        const ep = eps[byId.get(id) ?? -1];
        return ep ? folded(ep) : false;
      },
      toggleFold: (id) => {
        const ep = eps[byId.get(id) ?? -1];
        if (ep) setFoldOverride((m) => new Map(m).set(id, !folded(ep)));
      },
    };
  }, [data, folded]);

  const goTo = useCallback(
    (target: string) => void navigate({ search: target === today ? {} : { day: target } }),
    [navigate, today],
  );

  // ← / → step through days (ignored while typing or using a media control).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const el = document.activeElement;
      if (el && /^(INPUT|TEXTAREA|SELECT|AUDIO)$/.test(el.tagName)) return;
      if (e.key === "ArrowLeft") goTo(shiftDay(day, -1));
      if (e.key === "ArrowRight" && day < today) goTo(shiftDay(day, 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [day, today, goTo]);

  const jumpTo = useCallback(
    (t: number) => {
      if (entries.length === 0) return;
      const entry = entries[entryIndexAt(entries, t)];
      const el = entry && document.getElementById(`e-${entry.key}`);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      el.animate([{ backgroundColor: "var(--accent-soft)" }, { backgroundColor: "transparent" }], {
        duration: 1800,
        easing: "ease-out",
      });
    },
    [entries],
  );

  const otherZone = tz !== browserTimeZone();

  return (
    <>
      <PageHeader
        title="Timeline"
        description={
          <>
            {formatDayLabel(day)}
            {isToday ? " · today" : ""}
            {otherZone ? ` · times in ${tz}` : ""}
          </>
        }
        actions={<BookmarkNow tz={tz} />}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Link
            to="/timeline"
            search={{ day: shiftDay(day, -1) }}
            className={buttonClass("secondary", "icon")}
            aria-label="Previous day"
            title="Previous day (←)"
          >
            <ChevronLeft aria-hidden />
          </Link>
          <Link
            to="/timeline"
            search={{}}
            disabled={isToday}
            aria-disabled={isToday || undefined}
            className={buttonClass("secondary", "md")}
          >
            Today
          </Link>
          <Link
            to="/timeline"
            search={shiftDay(day, 1) === today ? {} : { day: shiftDay(day, 1) }}
            disabled={day >= today}
            aria-disabled={day >= today || undefined}
            className={buttonClass("secondary", "icon")}
            aria-label="Next day"
            title="Next day (→)"
          >
            <ChevronRight aria-hidden />
          </Link>
        </div>
        <Input
          type="date"
          aria-label="Pick a day"
          value={day}
          max={today}
          onChange={(e) => {
            if (DAY_RE.test(e.target.value)) goTo(e.target.value);
          }}
          className="w-auto"
        />
        {data ? <FilterChips data={data} filters={filters} onToggle={toggleFilter} /> : null}
        {timeline.isFetching && data ? <Spinner className="text-ink-3" /> : null}
      </div>

      {timeline.error ? (
        <ErrorNotice
          error={timeline.error}
          onRetry={() => void timeline.refetch()}
          className="mb-4"
        />
      ) : null}

      {data ? (
        <div className="flex flex-col gap-4">
          <Card className="flex flex-col gap-4 p-4">
            <Summary data={data} />
            <DayStrip data={data} from={range.from} to={range.to} tz={tz} onPick={jumpTo} />
          </Card>
          <TimelineActionsProvider value={actions}>
            <DayList data={data} entries={entries} isToday={isToday} tz={tz} />
          </TimelineActionsProvider>
        </div>
      ) : timeline.isPending ? (
        <Card>
          <LoadingRows rows={8} />
        </Card>
      ) : null}
    </>
  );
}

function Summary({ data }: { data: Timeline }) {
  const recordedMs = data.chunks.reduce((sum, c) => sum + c.durationMs, 0);
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
      <Stat label="Audio recorded" value={recordedMs > 0 ? formatDuration(recordedMs) : "—"} />
      <Stat label="Episodes" value={data.episodes.length} />
      <Stat label="Utterances" value={data.utterances.length} />
      <Stat label="Sound events" value={data.soundEvents.length} />
      <Stat label="Bookmarks" value={data.bookmarks.length} />
    </div>
  );
}

const FILTERS: Array<{ key: keyof Filters; label: string; count: (d: Timeline) => number }> = [
  { key: "audio", label: "Audio", count: (d) => d.chunks.length },
  { key: "speech", label: "Speech", count: (d) => d.utterances.length },
  { key: "sounds", label: "Sounds", count: (d) => d.soundEvents.length },
  { key: "bookmarks", label: "Bookmarks", count: (d) => d.bookmarks.length },
  { key: "device", label: "Device", count: (d) => visibleDeviceEvents(d.deviceEvents).length },
];

function FilterChips({
  data,
  filters,
  onToggle,
}: {
  data: Timeline;
  filters: Filters;
  onToggle: (key: keyof Filters) => void;
}) {
  return (
    <fieldset className="flex flex-wrap items-center gap-1 sm:ml-auto">
      <legend className="sr-only">Show in timeline</legend>
      {FILTERS.map(({ key, label, count }) => (
        <button
          key={key}
          type="button"
          aria-pressed={filters[key]}
          onClick={() => onToggle(key)}
          className={cn(
            "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors",
            filters[key]
              ? "border-accent/40 bg-accent-soft text-accent-ink"
              : "border-line bg-surface text-ink-3 hover:text-ink-2",
          )}
        >
          {label}
          <span className="tabular opacity-75">{count(data)}</span>
        </button>
      ))}
    </fieldset>
  );
}

function DayList({
  data,
  entries,
  isToday,
  tz,
}: {
  data: Timeline;
  entries: ReturnType<typeof buildEntries>;
  isToday: boolean;
  tz: string;
}) {
  const nothing =
    data.chunks.length === 0 &&
    data.utterances.length === 0 &&
    data.soundEvents.length === 0 &&
    data.bookmarks.length === 0 &&
    data.deviceEvents.length === 0 &&
    data.episodes.length === 0;

  if (nothing) {
    return (
      <Card>
        <EmptyState icon={<CalendarX2 />} title="Nothing recorded on this day">
          {isToday
            ? "Start capture in the iOS app — audio appears here within a minute of recording."
            : "No audio, bookmarks or device events were stored for this day."}
        </EmptyState>
      </Card>
    );
  }

  return (
    <Card>
      {data.chunks.length > 0 && data.utterances.length === 0 ? (
        <div className="flex items-start gap-2 border-b border-line bg-accent-soft/50 px-4 py-2.5 text-[13px] text-ink-2">
          <Info className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
          <p>
            <span className="font-medium text-ink">No transcript yet — audio is recorded.</span>{" "}
            Speech and sound events will appear here once processing is enabled; you can already
            play every clip below.
          </p>
        </div>
      ) : null}
      {entries.length === 0 ? (
        <EmptyState icon={<FileAudio />} title="Everything is filtered out">
          Turn some of the filters above back on.
        </EmptyState>
      ) : (
        <ol className="px-3 py-2">
          {entries.map((entry) => (
            <EntryView key={entry.key} entry={entry} tz={tz} />
          ))}
        </ol>
      )}
    </Card>
  );
}

function BookmarkNow({ tz }: { tz: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const create = useMutation(
    orpc.bookmarks.create.mutationOptions({
      onSuccess: (bookmark) => {
        toast({
          tone: "good",
          title: "Bookmarked",
          description: formatTime(bookmark.at, tz, true),
        });
        void queryClient.invalidateQueries({ queryKey: orpc.timeline.key() });
      },
      onError: (error) =>
        toast({ tone: "bad", title: "Could not bookmark", description: errorMessage(error) }),
    }),
  );
  return (
    <Button variant="primary" loading={create.isPending} onClick={() => create.mutate({})}>
      <Flag aria-hidden />
      Bookmark now
    </Button>
  );
}
