import type { OwnVoiceprint, TeachResultItem, VoiceCommand, VoiceStatus } from "@hearloom/api";
import { compactName, matchWake, nearWake, type Settings } from "@hearloom/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AudioLines,
  Check,
  CircleHelp,
  GraduationCap,
  History,
  Mic,
  MicOff,
  Radio,
  Send,
  Square,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { RelTime } from "../../components/bits";
import { Badge, type Tone } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader, PageHeader } from "../../components/ui/card";
import { ConfirmButton } from "../../components/ui/dialog";
import { Field, Input } from "../../components/ui/input";
import { Dot, EmptyState, ErrorNotice, LoadingRows } from "../../components/ui/misc";
import { SettingRow, Switch } from "../../components/ui/switch";
import { useToast } from "../../components/ui/toast";
import { cn } from "../../lib/cn";
import { useTimeZone } from "../../lib/me";
import { pcmToBase64, type Recording, startRecording } from "../../lib/mic";
import { client, errorMessage, orpc } from "../../lib/orpc";
import { formatTime, useNow } from "../../lib/time";

export const Route = createFileRoute("/_app/voice")({
  component: VoicePage,
});

type VoiceSettings = Settings["voice"];

function VoicePage() {
  const settings = useQuery(orpc.settings.get.queryOptions());
  const status = useQuery(
    orpc.voice.status.queryOptions({
      // Realtime pushes teaching results; poll too while teaching, in case an event is lost.
      refetchInterval: (q) => (q.state.data?.teach ? 4_000 : false),
    }),
  );
  const name = settings.data?.voice.names[0] ?? "Hermes";
  return (
    <>
      <PageHeader
        title="Voice"
        description={`Say “Hey ${name}, …” and Hearloom hands the request to your agent, which answers on its own channel (e.g. Telegram). Only your own voice counts.`}
      />
      {settings.error || status.error ? (
        <ErrorNotice
          error={settings.error ?? status.error}
          onRetry={() => {
            void settings.refetch();
            void status.refetch();
          }}
        />
      ) : !settings.data || !status.data ? (
        <LoadingRows rows={4} />
      ) : (
        <div className="flex flex-col gap-4">
          <TeachCard voice={settings.data.voice} status={status.data} />
          <ManageCard voice={settings.data.voice} status={status.data} />
          <CommandsCard />
        </div>
      )}
    </>
  );
}

// ---- Management -------------------------------------------------------------------------------

const MODES: { value: VoiceSettings["mode"]; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "Nothing is detected." },
  {
    value: "shadow",
    label: "Shadow",
    hint: "Detected and logged below, but not sent (and the pendant doesn't buzz): see how well it works first.",
  },
  { value: "on", label: "On", hint: "Commands go to your agent." },
];

function useSaveVoice() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation(
    orpc.settings.update.mutationOptions({
      onSuccess: (next) => {
        queryClient.setQueryData(orpc.settings.get.queryKey(), next);
        void queryClient.invalidateQueries({ queryKey: orpc.me.key() });
      },
      onError: (err) =>
        toast({ tone: "bad", title: "Couldn't save", description: errorMessage(err) }),
    }),
  );
}

function ManageCard({ voice, status }: { voice: VoiceSettings; status: VoiceStatus }) {
  const save = useSaveVoice();
  const toast = useToast();
  const queryClient = useQueryClient();
  const test = useMutation(
    orpc.voice.test.mutationOptions({
      onSuccess: (r) => {
        void queryClient.invalidateQueries({ queryKey: orpc.voice.key() });
        if (r.status === "sent")
          toast({
            tone: "good",
            title: "Test command sent",
            description: `The agent accepted it (HTTP ${r.httpStatus}). Its reply should arrive on its channel.`,
          });
        else
          toast({
            tone: "bad",
            title: "Test command failed",
            description: r.reason ?? "unknown error",
          });
      },
      onError: (err) =>
        toast({ tone: "bad", title: "Test command failed", description: errorMessage(err) }),
    }),
  );
  const mode = MODES.find((m) => m.value === voice.mode)!;

  return (
    <Card>
      <CardHeader
        icon={<Radio aria-hidden />}
        title="Voice commands"
        description="One setting, one name. The rest is learned."
        actions={
          <Button
            size="sm"
            onClick={() => test.mutate({})}
            loading={test.isPending}
            disabled={!status.webhookConfigured}
            title={status.webhookConfigured ? undefined : "Set the webhook URL on the Agent page"}
          >
            <Send aria-hidden /> Send test command
          </Button>
        }
      />
      <CardBody className="flex flex-col divide-y divide-line">
        <SettingRow
          title="Mode"
          description={
            status.profile.canEnable
              ? mode.hint
              : "Teach Hearloom your voice first: commands only ever come from you."
          }
        >
          <fieldset
            aria-label="Voice command mode"
            className="m-0 inline-flex rounded-md border border-line bg-surface-2 p-0.5"
          >
            {MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                aria-pressed={voice.mode === m.value}
                disabled={save.isPending || (m.value !== "off" && !status.profile.canEnable)}
                onClick={() => save.mutate({ voice: { mode: m.value } })}
                className={cn(
                  "h-7 cursor-pointer rounded px-3 text-xs font-medium text-ink-2 disabled:cursor-not-allowed disabled:opacity-40",
                  voice.mode === m.value && "bg-surface text-ink shadow-sm",
                )}
              >
                {m.label}
              </button>
            ))}
          </fieldset>
        </SettingRow>
        <div className="flex flex-wrap gap-x-6 gap-y-1 py-3 text-xs text-ink-3">
          <span className="inline-flex items-center gap-1.5">
            <Dot tone={status.webhookConfigured ? "good" : "warn"} />
            {status.webhookConfigured ? (
              "Agent webhook set"
            ) : (
              <span>
                No agent webhook —{" "}
                <Link to="/agent" className="text-accent-ink underline">
                  set it on the Agent page
                </Link>
              </span>
            )}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Dot tone={status.pipelineRunning ? "good" : "bad"} />
            {status.pipelineRunning ? "Live pipeline running" : "Live pipeline not running"}
          </span>
        </div>
        <NamesRow voice={voice} />
        <SettingRow
          title="Buzz the pendant"
          htmlFor="voice-haptics"
          description={
            voice.mode === "on"
              ? "One tap when it hears “hey …”; two taps when the agent has answered. If something went wrong: one longer buzz, no command came; three taps, not sent or no answer within two minutes."
              : "Only in mode On, so nothing buzzes now. In On: one tap when it hears “hey …”; two taps when the agent has answered. If something went wrong: one longer buzz, no command came; three taps, not sent or no answer within two minutes."
          }
        >
          <Switch
            id="voice-haptics"
            checked={voice.haptics}
            disabled={save.isPending}
            onChange={(haptics) => save.mutate({ voice: { haptics } })}
          />
        </SettingRow>
        <AliasesRow voice={voice} />
        <TryPhrase voice={voice} />
      </CardBody>
    </Card>
  );
}

function NamesRow({ voice }: { voice: VoiceSettings }) {
  const save = useSaveVoice();
  const [draft, setDraft] = useState(voice.names.join(", "));
  const id = useId();
  useEffect(() => setDraft(voice.names.join(", ")), [voice.names]);
  const names = draft
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  const valid = names.length >= 1 && names.length <= 3 && names.every((n) => n.length >= 2);
  const changed = names.join(",") !== voice.names.join(",");
  return (
    <SettingRow
      title="Agent name"
      htmlFor={id}
      description="What you call it after “hey”. Up to 3, comma separated. Changing it clears the learned spellings: teach a few phrases again."
    >
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && changed) save.mutate({ voice: { names } });
        }}
      >
        <Input id={id} value={draft} onChange={(e) => setDraft(e.target.value)} className="w-48" />
        <Button type="submit" size="sm" disabled={!valid || !changed} loading={save.isPending}>
          Save
        </Button>
      </form>
    </SettingRow>
  );
}

function Chip({
  children,
  onRemove,
  tone,
}: {
  children: ReactNode;
  onRemove: () => void;
  tone: Tone;
}) {
  return (
    <Badge tone={tone} className="gap-1 pr-1">
      {children}
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove"
        className="cursor-pointer rounded p-0.5 hover:bg-black/10"
      >
        <X aria-hidden />
      </button>
    </Badge>
  );
}

function AliasesRow({ voice }: { voice: VoiceSettings }) {
  const save = useSaveVoice();
  const [draft, setDraft] = useState("");
  const id = useId();
  const add = () => {
    const a = draft.trim();
    if (a.length < 2 || voice.aliases.some((x) => compactName(x) === compactName(a))) return;
    save.mutate({ voice: { aliases: [...voice.aliases, a].slice(-20) } });
    setDraft("");
  };
  return (
    <div className="flex flex-col gap-2 py-3">
      <div>
        <label htmlFor={id} className="block text-[13px] font-medium text-ink">
          How the name is heard
        </label>
        <p className="text-xs text-ink-3">
          Spellings the speech recognizer produced for the name in your voice. Learned while you
          teach and when you confirm commands; remove wrong ones. Close spellings match anyway.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {voice.aliases.length === 0 ? (
          <span className="text-xs text-ink-3">None learned yet.</span>
        ) : (
          voice.aliases.map((a) => (
            <Chip
              key={a}
              tone="info"
              onRemove={() =>
                save.mutate({ voice: { aliases: voice.aliases.filter((x) => x !== a) } })
              }
            >
              {a}
            </Chip>
          ))
        )}
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <Input
            id={id}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a spelling"
            className="h-7 w-36 text-xs"
          />
          <Button type="submit" size="sm" variant="ghost" disabled={draft.trim().length < 2}>
            Add
          </Button>
        </form>
      </div>
      {voice.blocked.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-ink-3">Never matched loosely (false triggers):</span>
          {voice.blocked.map((b) => (
            <Chip
              key={b}
              tone="neutral"
              onRemove={() =>
                save.mutate({ voice: { blocked: voice.blocked.filter((x) => x !== b) } })
              }
            >
              {b}
            </Chip>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TryPhrase({ voice }: { voice: VoiceSettings }) {
  const [text, setText] = useState("");
  const id = useId();
  const cfg = { names: voice.names, aliases: voice.aliases, blocked: voice.blocked };
  const match = text.trim() ? matchWake(text, cfg) : null;
  const near = text.trim() && !match ? nearWake(text, cfg) : null;
  return (
    <div className="flex flex-col gap-2 pt-3">
      <Field
        label="Try a phrase"
        htmlFor={id}
        hint="Type what the transcript might say; this runs the same matcher as the server."
      >
        <Input
          id={id}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={`Hey ${voice.names[0]}, what's the weather tomorrow?`}
        />
      </Field>
      {text.trim() ? (
        <div className="rounded-md border border-line bg-surface-2 px-3 py-2 text-[13px]">
          {match ? (
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="good" dot>
                Wakes {match.name}
              </Badge>
              <span className="text-ink-3">
                heard as “{match.heardAs}” ·{" "}
                {match.score === 1
                  ? "exact"
                  : match.score >= 0.9
                    ? "close spelling"
                    : "sounds alike"}
              </span>
              <span className="min-w-0 basis-full text-ink">
                {match.command ? (
                  <>
                    Command: <q>{match.command}</q>
                  </>
                ) : (
                  <span className="text-ink-3">
                    Wake word only: the next thing you say becomes the command.
                  </span>
                )}
              </span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="neutral">No wake phrase</Badge>
              <span className="text-ink-3">
                {near
                  ? `“${near.heardAs}” is close to ${near.name} but not close enough: it would be logged as a near miss.`
                  : "Start with a greeting (hey, hi, ok, hoi…) and the name."}
              </span>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ---- Teaching ---------------------------------------------------------------------------------

function pct(v: number | null): string {
  return v === null ? "—" : `${Math.round(v * 100)}%`;
}

function Readiness({ profile }: { profile: VoiceStatus["profile"] }) {
  const level =
    profile.voiceprints === 0
      ? { label: "Not taught yet", tone: "warn" as const }
      : profile.progress < 0.5
        ? { label: "Getting there", tone: "info" as const }
        : profile.progress < 1
          ? { label: "Good", tone: "good" as const }
          : { label: "Ready", tone: "good" as const };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Badge tone={level.tone} dot>
          {level.label}
        </Badge>
        <div
          className="relative h-2 flex-1 overflow-hidden rounded-full bg-accent-track/60"
          role="progressbar"
          aria-label="Voice model"
          aria-valuenow={Math.round(profile.progress * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width]"
            style={{ width: `${Math.round(profile.progress * 100)}%` }}
          />
        </div>
        <span className="tabular text-xs text-ink-3">{Math.round(profile.progress * 100)}%</span>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-4">
        <Stat label="Samples" value={profile.samples} />
        <Stat label="Voice learned" value={`${Math.round(profile.voiceSeconds)} s`} />
        <Stat
          label="Consistency"
          value={pct(profile.consistency)}
          hint="How alike your samples sound to your voice so far"
        />
        <Stat
          label="Name recognized"
          value={pct(profile.nameRecognition)}
          hint="Samples where the matcher recognized the name"
        />
      </dl>
      <p className="text-xs text-ink-3">
        Own-voice threshold {profile.threshold.toFixed(2)}
        {profile.thresholdLearned ? " (tuned from your samples)" : " (default until 3 samples)"}.
        Phrases shorter than {profile.minPrintSeconds} s teach the name but not the voice.
      </p>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div title={hint}>
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className="tabular font-medium text-ink">{value}</dd>
    </div>
  );
}

function TeachCard({ voice, status }: { voice: VoiceSettings; status: VoiceStatus }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.voice.key() });
  const onError = (err: unknown) =>
    toast({ tone: "bad", title: "Teaching", description: errorMessage(err) });
  const start = useMutation(
    orpc.voice.teach.start.mutationOptions({ onSuccess: refresh, onError }),
  );
  const stop = useMutation(orpc.voice.teach.stop.mutationOptions({ onSuccess: refresh, onError }));
  const teach = status.teach;
  const name = voice.names[0];

  return (
    <Card>
      <CardHeader
        icon={<GraduationCap aria-hidden />}
        title="Teach your voice"
        description="Say a few phrases so Hearloom knows your voice and how you say the name. The more you teach, the better it reacts."
        actions={
          teach ? (
            <Button size="sm" onClick={() => stop.mutate({})} loading={stop.isPending}>
              <Check aria-hidden /> Done
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                onClick={() => start.mutate({ kind: "test" })}
                loading={start.isPending && start.variables?.kind === "test"}
                disabled={status.profile.voiceprints === 0}
                title={status.profile.voiceprints === 0 ? "Teach your voice first" : undefined}
              >
                <CircleHelp aria-hidden /> Self-test
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => start.mutate({ kind: "sample" })}
                loading={start.isPending && start.variables?.kind === "sample"}
              >
                <Mic aria-hidden /> {status.profile.samples > 0 ? "Teach more" : "Start teaching"}
              </Button>
            </>
          )
        }
      />
      <CardBody className="flex flex-col gap-5">
        {teach ? <TeachSession teach={teach} status={status} name={name ?? "Hermes"} /> : null}
        <Readiness profile={status.profile} />
        {status.profile.voiceprints > 0 ? <OwnVoiceprints /> : null}
      </CardBody>
    </Card>
  );
}

/** Below this average similarity to the others, a voiceprint is probably not (only) the user. */
const OUTLIER_SIMILARITY = 0.45;

const PRINT_SOURCE: Record<OwnVoiceprint["source"], string> = {
  enrollment: "taught / command",
  confirmed: "“This is me”",
};

/** The user's voiceprints, to spot and remove one learned from a bad clip. */
function OwnVoiceprints() {
  const tz = useTimeZone() ?? "UTC";
  const now = useNow();
  const toast = useToast();
  const queryClient = useQueryClient();
  const prints = useQuery(orpc.voice.voiceprints.queryOptions());
  const remove = useMutation(
    orpc.voice.removeVoiceprint.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.voice.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.people.key() });
        toast({ tone: "good", title: "Voiceprint deleted" });
      },
    }),
  );
  const outliers = (prints.data ?? []).filter(
    (p) => p.similarity !== null && p.similarity < OUTLIER_SIMILARITY,
  ).length;
  return (
    <details className="text-[13px]">
      <summary className="cursor-pointer text-xs text-ink-3 select-none">
        Your voiceprints{prints.data ? ` (${prints.data.length})` : ""}
        {outliers > 0 ? ` · ${outliers} unlike the rest` : ""}
      </summary>
      {prints.error ? (
        <ErrorNotice error={prints.error} onRetry={() => void prints.refetch()} className="mt-2" />
      ) : !prints.data ? (
        <LoadingRows rows={2} />
      ) : (
        <div className="mt-2 overflow-x-auto">
          <p className="mb-2 text-xs text-ink-3">
            Each clip Hearloom learned your voice from. One that sounds unlike the rest (low
            similarity) may be someone else or noise: it lets other voices pass as yours. Delete it.
          </p>
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-line text-xs text-ink-3">
              <tr>
                <th className={th}>Learned</th>
                <th className={th}>From</th>
                <th className={cn(th, "text-right")}>Length</th>
                <th
                  className={cn(th, "text-right")}
                  title="Average similarity to your other voiceprints"
                >
                  Like the rest
                </th>
                <th className={th} />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {prints.data.map((p) => {
                const outlier = p.similarity !== null && p.similarity < OUTLIER_SIMILARITY;
                return (
                  <tr key={p.id}>
                    <td className={cn(td, "whitespace-nowrap text-ink-2")}>
                      <span title={formatTime(p.createdAt, tz, true)}>
                        <RelTime date={p.createdAt} now={now} tz={tz} />
                      </span>
                    </td>
                    <td className={cn(td, "text-ink-2")}>{PRINT_SOURCE[p.source]}</td>
                    <td className={cn(td, "tabular text-right text-ink-2")}>
                      {p.seconds.toFixed(1)} s
                    </td>
                    <td className={cn(td, "tabular text-right")}>
                      {p.similarity === null ? (
                        "—"
                      ) : outlier ? (
                        <Badge tone="warn">{p.similarity.toFixed(2)}</Badge>
                      ) : (
                        <span className="text-ink-2">{p.similarity.toFixed(2)}</span>
                      )}
                    </td>
                    <td className={cn(td, "text-right")}>
                      <ConfirmButton
                        title={
                          prints.data.length === 1
                            ? "Delete your last voiceprint?"
                            : "Delete this voiceprint?"
                        }
                        description={
                          prints.data.length === 1
                            ? "It's the only one: voice commands stop working (nothing can be checked as your voice) until you teach your voice again on this page."
                            : "Hearloom stops comparing voices with this clip. The rest of your voice stays learned."
                        }
                        confirmLabel="Delete"
                        onConfirm={() => remove.mutateAsync({ id: p.id })}
                        variant="ghost"
                        size="icon"
                      >
                        <Trash2 aria-hidden />
                        <span className="sr-only">Delete voiceprint</span>
                      </ConfirmButton>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}

/** Phrases per round of the progress dots. */
const PROGRESS_DOTS = [0, 1, 2, 3, 4, 5, 6, 7];

/** Unmount stops wait this long, so a remount (React StrictMode in dev) can call them off. */
const STOP_DELAY_MS = 300;
const pendingStops = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * While teaching, the user's wake phrases are taught instead of sent: end the session when the
 * page goes away (navigation, tab hidden or closed) rather than leaving it to time out.
 */
function useStopTeachingWhenGone(sessionId: string) {
  const queryClient = useQueryClient();
  useEffect(() => {
    clearTimeout(pendingStops.get(sessionId));
    pendingStops.delete(sessionId);
    const stop = () =>
      void client.voice.teach
        .stop({ sessionId })
        .then(() => queryClient.invalidateQueries({ queryKey: orpc.voice.key() }))
        .catch(() => {});
    const onVisibility = () => {
      if (document.visibilityState === "hidden") stop();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", stop);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", stop);
      pendingStops.set(
        sessionId,
        setTimeout(() => {
          pendingStops.delete(sessionId);
          stop();
        }, STOP_DELAY_MS),
      );
    };
  }, [sessionId, queryClient]);
}

function TeachSession({
  teach,
  status,
  name,
}: {
  teach: NonNullable<VoiceStatus["teach"]>;
  status: VoiceStatus;
  name: string;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const skip = useMutation(
    orpc.voice.teach.skip.mutationOptions({
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: orpc.voice.key() }),
    }),
  );
  const [useBrowser, setUseBrowser] = useState(!status.pendantLive);
  const sample = teach.kind === "sample";
  useStopTeachingWhenGone(teach.sessionId);
  const last = teach.results[0];
  // Flash the latest result briefly when it arrives.
  const [fresh, setFresh] = useState(false);
  const lastKey = last ? `${last.index}:${last.text}` : "";
  useEffect(() => {
    if (!lastKey) return;
    setFresh(true);
    const t = setTimeout(() => setFresh(false), 1500);
    return () => clearTimeout(t);
  }, [lastKey]);

  return (
    <div className="flex flex-col gap-4">
      <div
        className={cn(
          "rounded-xl border px-5 py-6 text-center transition-colors",
          fresh && last?.ok ? "border-good bg-good-soft" : "border-accent/40 bg-accent-soft",
        )}
      >
        <p className="text-xs font-medium tracking-wide text-accent-ink uppercase">
          {sample ? `Phrase ${teach.taken + 1} · say` : "Self-test · say"}
        </p>
        <p className="mt-2 text-2xl font-semibold tracking-tight text-ink">
          “{sample ? teach.phrase : `Hey ${name}, …anything`}”
        </p>
        <p className="mt-2 text-xs text-ink-3">
          {useBrowser
            ? "Record it with your browser mic below."
            : status.pendantLive
              ? "Listening through your pendant — just say it, at your normal volume."
              : "Your pendant isn't streaming. Record with the browser mic instead."}
        </p>
        {sample ? (
          <div className="mt-3 flex justify-center gap-1" aria-hidden>
            {PROGRESS_DOTS.map((i) => (
              <span
                key={i}
                className={cn(
                  "h-1.5 w-6 rounded-full",
                  i < teach.taken % 8 || (teach.taken > 0 && teach.taken % 8 === 0)
                    ? "bg-accent"
                    : "bg-accent-track",
                )}
              />
            ))}
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {useBrowser ? (
          <BrowserRecorder
            sessionId={teach.sessionId}
            onError={(m) => toast({ tone: "bad", title: "Recording", description: m })}
          />
        ) : (
          <span className="inline-flex items-center gap-2 text-[13px] text-ink-2">
            <Dot tone={status.pendantLive ? "good" : "warn"} pulse={status.pendantLive} />
            {status.pendantLive ? "Pendant listening" : "Pendant not streaming"}
          </span>
        )}
        <Button size="sm" variant="ghost" onClick={() => setUseBrowser((v) => !v)}>
          {useBrowser ? (
            <>
              <Radio aria-hidden /> Use the pendant
            </>
          ) : (
            <>
              <Mic aria-hidden /> Use the browser mic
            </>
          )}
        </Button>
        {sample ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => skip.mutate({})}
            loading={skip.isPending}
          >
            Skip phrase
          </Button>
        ) : null}
        {useBrowser ? (
          <span className="basis-full text-xs text-ink-3">
            The pendant is better: same mic as real use. Browser recordings go through the pendant's
            codec but still sound a bit different.
          </span>
        ) : null}
      </div>

      {teach.results.length > 0 ? (
        <ul className="divide-y divide-line rounded-md border border-line">
          {teach.results.map((r) => (
            <TeachResultRow key={`${r.index}:${r.source}:${r.text}:${r.seconds}`} r={r} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function TeachResultRow({ r }: { r: TeachResultItem }) {
  const verdict =
    r.kind === "test"
      ? r.wouldTrigger
        ? { tone: "good" as const, label: "Would trigger" }
        : r.wouldMatch
          ? { tone: "warn" as const, label: "Name heard, voice not sure" }
          : { tone: "bad" as const, label: "Wouldn't trigger" }
      : r.ok
        ? { tone: "good" as const, label: "Learned" }
        : r.error
          ? { tone: "bad" as const, label: "Not learned" }
          : { tone: "warn" as const, label: "Didn't match — try again" };
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[13px]">
      <Badge tone={verdict.tone} dot>
        {verdict.label}
      </Badge>
      <span className="min-w-0 flex-1 truncate text-ink">
        {r.error ? <span className="text-bad-ink">{r.error}</span> : r.text ? <q>{r.text}</q> : "—"}
      </span>
      <span className="flex items-center gap-3 text-xs text-ink-3">
        {r.heardAs ? (
          <span title="How the name was transcribed">
            name: “{r.heardAs}”{r.nameScore === 0 ? " (new)" : ""}
          </span>
        ) : null}
        {r.speakerScore !== null ? (
          <span title="Similarity to your voice so far">voice {r.speakerScore.toFixed(2)}</span>
        ) : null}
        {r.voiceprintId ? <Badge tone="info">+ voiceprint</Badge> : null}
        <span>{r.source === "browser" ? "browser" : "pendant"}</span>
      </span>
    </li>
  );
}

function BrowserRecorder({
  sessionId,
  onError,
}: {
  sessionId: string;
  onError: (m: string) => void;
}) {
  const [rec, setRec] = useState<Recording | null>(null);
  const [level, setLevel] = useState(0);
  const queryClient = useQueryClient();
  const upload = useMutation(
    orpc.voice.teach.upload.mutationOptions({
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: orpc.voice.key() }),
      onError: (err) => onError(errorMessage(err)),
    }),
  );
  const raf = useRef(0);
  useEffect(() => {
    if (!rec) return;
    const tick = () => {
      setLevel(rec.level());
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [rec]);
  useEffect(() => () => rec?.cancel(), [rec]);

  const begin = async () => {
    try {
      setRec(await startRecording());
    } catch (err) {
      onError(err instanceof Error ? err.message : "Microphone unavailable");
    }
  };
  const finish = async () => {
    if (!rec) return;
    const pcm = await rec.stop();
    setRec(null);
    if (pcm.length < 8_000) {
      onError("That was too short — hold on a little longer.");
      return;
    }
    upload.mutate({ sessionId, pcm: pcmToBase64(pcm) });
  };

  return rec ? (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="danger" onClick={() => void finish()}>
        <Square aria-hidden /> Stop and send
      </Button>
      <span className="relative h-1.5 w-24 overflow-hidden rounded-full bg-surface-3" aria-hidden>
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-good"
          style={{ width: `${Math.min(100, Math.round(level * 140))}%` }}
        />
      </span>
      <Button size="sm" variant="ghost" onClick={() => setRec(null)}>
        <MicOff aria-hidden /> Cancel
      </Button>
    </div>
  ) : (
    <Button size="sm" variant="primary" onClick={() => void begin()} loading={upload.isPending}>
      <Mic aria-hidden /> {upload.isPending ? "Listening to it…" : "Record"}
    </Button>
  );
}

// ---- Log ----------------------------------------------------------------------------------------

const STATUS: Record<VoiceCommand["status"], { tone: Tone; label: string }> = {
  pending: { tone: "info", label: "sending" },
  sent: { tone: "good", label: "sent" },
  failed: { tone: "bad", label: "failed" },
  expired: { tone: "bad", label: "expired" },
  shadow: { tone: "accent", label: "shadow" },
  ignored: { tone: "neutral", label: "ignored" },
  test: { tone: "info", label: "test" },
};

const REASON: Record<string, string> = {
  no_voiceprint: "no voiceprint yet",
  clip_missing: "audio missing (reconnected?)",
  clip_too_short: "too short to check the voice",
  check_error: "voice check failed",
  not_own_voice: "not your voice",
  media_voice: "TV / radio",
  rate_limited: "too many",
  no_command: "nothing followed",
  near_miss: "name not recognized",
  teaching: "while teaching",
  restart: "server restarted",
  mode_off: "turned off meanwhile",
  no_webhook: "no webhook",
  route_ignored: "route ignores voice.command",
  too_old: "too old",
};

function reasonText(r: string | null): string | null {
  if (!r) return null;
  return REASON[r] ?? r.replace(/^http_/, "HTTP ");
}

const th = "px-3 py-2 font-medium first:pl-4 last:pr-4";
const td = "px-3 py-2.5 align-top first:pl-4 last:pr-4";

function CommandsCard() {
  const tz = useTimeZone() ?? "UTC";
  const now = useNow();
  const commands = useQuery(orpc.voice.commands.queryOptions({ input: { limit: 50 } }));
  return (
    <Card>
      <CardHeader
        icon={<History aria-hidden />}
        title="Recent commands"
        description="Everything the wake phrase caught, sent or not. Tell it when it got you wrong: confirmed and missed ones are learned from."
      />
      {commands.error ? (
        <ErrorNotice
          error={commands.error}
          onRetry={() => void commands.refetch()}
          className="m-4"
        />
      ) : commands.isLoading ? (
        <LoadingRows />
      ) : (commands.data ?? []).length === 0 ? (
        <EmptyState icon={<AudioLines aria-hidden />} title="Nothing yet">
          Turn on Shadow or On and say “Hey …, ” followed by a request.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-line text-xs text-ink-3">
              <tr>
                <th className={th}>When</th>
                <th className={th}>Command</th>
                <th className={th}>Status</th>
                <th className={cn(th, "text-right")}>Voice</th>
                <th className={cn(th, "text-right")}>Latency</th>
                <th className={cn(th, "text-right")}>Was it right?</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {commands.data!.map((c) => (
                <CommandRow key={c.id} c={c} tz={tz} now={now} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** Ignored detections that can be marked as missed (the server enforces the same). */
const MISSABLE = new Set([
  "near_miss",
  "no_command",
  "rate_limited",
  "no_voiceprint",
  "clip_missing",
  "clip_too_short",
  "check_error",
]);

function CommandRow({ c, tz, now }: { c: VoiceCommand; tz: string; now: number }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const feedback = useMutation(
    orpc.voice.feedback.mutationOptions({
      onSuccess: (r, input) => {
        void queryClient.invalidateQueries({ queryKey: orpc.voice.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.settings.key() });
        if (input.feedback === "confirmed" || input.feedback === "missed")
          toast(
            r.learned
              ? { tone: "good", title: "Learned from it", description: r.note ?? undefined }
              : { tone: "info", title: "Saved, nothing learned", description: r.note ?? undefined },
          );
      },
      onError: (err) =>
        toast({ tone: "bad", title: "Couldn't save", description: errorMessage(err) }),
    }),
  );
  const s = STATUS[c.status];
  const busy = feedback.isPending;
  // Missed only where the gate didn't hear someone else (see setFeedback on the server).
  const missable = c.status === "ignored" && MISSABLE.has(c.reason ?? "");
  const set = (f: VoiceCommand["feedback"]) =>
    feedback.mutate({ id: c.id, feedback: c.feedback === f ? null : f });
  const fired =
    c.status === "sent" || c.status === "shadow" || c.status === "failed" || c.status === "expired";
  return (
    <tr className={cn(c.feedback === "false_trigger" && "opacity-60")}>
      <td className={cn(td, "whitespace-nowrap text-ink-2")}>
        <span title={formatTime(c.spokenAt, tz, true)}>
          <RelTime date={c.spokenAt} now={now} tz={tz} />
        </span>
      </td>
      <td className={cn(td, "min-w-64")}>
        <div className="text-ink">
          {c.command ? c.command : <span className="text-ink-3">—</span>}
        </div>
        <div className="truncate text-xs text-ink-3" title={c.transcript}>
          heard “{c.heardAs}” · {c.transcript}
        </div>
      </td>
      <td className={cn(td, "whitespace-nowrap")}>
        <Badge tone={s.tone}>{s.label}</Badge>
        {reasonText(c.reason) ? (
          <div className="mt-0.5 text-xs text-ink-3">{reasonText(c.reason)}</div>
        ) : null}
      </td>
      <td className={cn(td, "tabular text-right text-ink-2")}>
        {c.speakerScore === null ? "—" : c.speakerScore.toFixed(2)}
      </td>
      <td className={cn(td, "tabular text-right text-ink-2")}>
        {c.latencyMs === null ? "—" : `${(c.latencyMs / 1000).toFixed(1)} s`}
      </td>
      <td className={cn(td, "whitespace-nowrap text-right")}>
        {c.status === "test" ? null : fired ? (
          <span className="inline-flex gap-1">
            <FeedbackButton
              disabled={busy}
              active={c.feedback === "confirmed"}
              onClick={() => set("confirmed")}
              label="It was me: learn from it"
              icon={<ThumbsUp aria-hidden />}
            />
            <FeedbackButton
              disabled={busy}
              active={c.feedback === "false_trigger"}
              onClick={() => set("false_trigger")}
              label="Wasn't me / false trigger"
              icon={<ThumbsDown aria-hidden />}
            />
          </span>
        ) : missable ? (
          <FeedbackButton
            disabled={busy}
            active={c.feedback === "missed"}
            onClick={() => set("missed")}
            label="Missed: it was me, it should have fired"
            icon={<span className="text-xs">Missed</span>}
          />
        ) : null}
      </td>
    </tr>
  );
}

function FeedbackButton({
  active,
  disabled,
  onClick,
  label,
  icon,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
  icon: ReactNode;
}) {
  return (
    <Button
      size="sm"
      variant={active ? "primary" : "ghost"}
      disabled={disabled}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
    >
      {icon}
    </Button>
  );
}
