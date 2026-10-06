import type { ButtonAction, Settings, SettingsPatch } from "@hearloom/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { BellRing, Check, Globe, Moon, MousePointerClick, Siren } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader, PageHeader } from "../../components/ui/card";
import { Input, Select } from "../../components/ui/input";
import { ErrorNotice, LoadingRows } from "../../components/ui/misc";
import { SettingRow, Switch } from "../../components/ui/switch";
import { useToast } from "../../components/ui/toast";
import { buttonActionLabel, buttonActions } from "../../lib/labels";
import { errorMessage, orpc } from "../../lib/orpc";
import { allTimeZones, browserTimeZone, isValidTimeZone } from "../../lib/time";

export const Route = createFileRoute("/_app/settings")({
  component: SettingsPage,
});

type Section = "quietHours" | "notifications" | "button" | "alerts";

/** Only the fields that changed between `base` and `draft`, shaped as a partial patch. */
function diff(base: Settings, draft: Settings): SettingsPatch {
  const patch: SettingsPatch = {};
  if (draft.timezone !== base.timezone) patch.timezone = draft.timezone;
  const sections: Section[] = ["quietHours", "notifications", "button", "alerts"];
  for (const section of sections) {
    const before = base[section] as Record<string, unknown>;
    const after = draft[section] as Record<string, unknown>;
    const changed: Record<string, unknown> = {};
    for (const key of Object.keys(after)) {
      if (key === "sources") continue;
      if (after[key] !== before[key]) changed[key] = after[key];
    }
    if (section === "notifications") {
      type Source = keyof Settings["notifications"]["sources"];
      const sources: Partial<Record<Source, boolean>> = {};
      for (const key of Object.keys(draft.notifications.sources) as Source[]) {
        const value = draft.notifications.sources[key];
        if (value !== base.notifications.sources[key]) sources[key] = value;
      }
      if (Object.keys(sources).length > 0) changed.sources = sources;
    }
    if (Object.keys(changed).length > 0) (patch as Record<string, unknown>)[section] = changed;
  }
  return patch;
}

function validate(s: Settings): Partial<Record<string, string>> {
  const errors: Partial<Record<string, string>> = {};
  const intIn = (v: number, min: number, max: number) =>
    Number.isInteger(v) && v >= min && v <= max;
  if (!s.timezone || !isValidTimeZone(s.timezone)) errors.timezone = "Unknown time zone";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.quietHours.start)) errors.quietStart = "Use HH:MM";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.quietHours.end)) errors.quietEnd = "Use HH:MM";
  if (!intIn(s.notifications.maxPerHour, 0, 60)) errors.maxPerHour = "0–60";
  if (!intIn(s.alerts.disconnectedAfterMin, 1, 240)) errors.disconnected = "1–240 minutes";
  if (!intIn(s.alerts.lowBatteryPercent, 0, 100)) errors.lowBattery = "0–100%";
  return errors;
}

function SettingsPage() {
  const settings = useQuery(orpc.settings.get.queryOptions());
  return (
    <>
      <PageHeader
        title="Settings"
        description="How Hearloom keeps time, interrupts you and reacts to the pendant."
      />
      {settings.error ? (
        <ErrorNotice error={settings.error} onRetry={() => void settings.refetch()} />
      ) : settings.data ? (
        <SettingsForm server={settings.data} />
      ) : (
        <Card>
          <LoadingRows rows={6} />
        </Card>
      )}
    </>
  );
}

function NumberInput({
  id,
  value,
  onChange,
  min,
  max,
  suffix,
  invalid,
}: {
  id: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  suffix?: string;
  invalid?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={Number.isNaN(value) ? "" : value}
        onChange={(e) => onChange(e.target.value === "" ? Number.NaN : Number(e.target.value))}
        aria-invalid={invalid || undefined}
        className="w-20 text-right tabular"
      />
      {suffix ? <span className="text-xs text-ink-3">{suffix}</span> : null}
    </span>
  );
}

function ErrorText({ children }: { children?: ReactNode }) {
  return children ? <span className="text-xs text-bad-ink">{children}</span> : null;
}

function SettingsForm({ server }: { server: Settings }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [base, setBase] = useState(server);
  const [draft, setDraft] = useState(server);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const patch = useMemo(() => diff(base, draft), [base, draft]);
  const dirty = Object.keys(patch).length > 0;
  const errors = useMemo(() => validate(draft), [draft]);
  const valid = Object.keys(errors).length === 0;

  // Follow changes made elsewhere (e.g. the phone) while there are no local edits.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only react to new server data
  useEffect(() => {
    if (!dirty) {
      setBase(server);
      setDraft(server);
    }
  }, [server]);

  useEffect(() => {
    if (savedAt === null) return;
    const id = setTimeout(() => setSavedAt(null), 3000);
    return () => clearTimeout(id);
  }, [savedAt]);

  const settingsKey = orpc.settings.get.queryKey();
  const save = useMutation(
    orpc.settings.update.mutationOptions({
      onMutate: async () => {
        await queryClient.cancelQueries({ queryKey: settingsKey });
        const previous = queryClient.getQueryData(settingsKey);
        // Optimistic: the form's values are what the server will store.
        queryClient.setQueryData(settingsKey, draft);
        setBase(draft);
        return { previous };
      },
      onError: (error, _patch, context) => {
        if (context?.previous) {
          queryClient.setQueryData(settingsKey, context.previous);
          setBase(context.previous);
        }
        toast({ tone: "bad", title: "Settings not saved", description: errorMessage(error) });
      },
      onSuccess: (saved) => {
        queryClient.setQueryData(settingsKey, saved);
        queryClient.setQueryData(orpc.me.get.queryKey(), (me) =>
          me ? { ...me, settings: saved } : me,
        );
        setBase(saved);
        setDraft(saved);
        setSavedAt(Date.now());
        toast({ tone: "good", title: "Settings saved" });
      },
    }),
  );

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const setIn = <S extends Section>(section: S, value: Partial<Settings[S]>) =>
    setDraft((d) => ({ ...d, [section]: { ...d[section], ...value } }));

  const zones = allTimeZones();
  const localZone = browserTimeZone();

  return (
    <form
      className="flex flex-col gap-4 pb-20"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && valid) save.mutate(patch);
      }}
    >
      <Card>
        <CardHeader
          icon={<Globe aria-hidden />}
          title="Time zone"
          description="Used for quiet hours and for day boundaries on the timeline."
        />
        <CardBody>
          <SettingRow
            title="IANA zone"
            htmlFor="timezone"
            description={
              errors.timezone ? (
                <ErrorText>{errors.timezone}</ErrorText>
              ) : (
                `Your browser is in ${localZone}.`
              )
            }
          >
            <Input
              id="timezone"
              list="timezones"
              value={draft.timezone}
              onChange={(e) => set("timezone", e.target.value.trim())}
              aria-invalid={errors.timezone ? true : undefined}
              className="w-60"
              autoComplete="off"
              spellCheck={false}
            />
            <datalist id="timezones">
              {zones.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
            {draft.timezone !== localZone ? (
              <Button size="sm" variant="ghost" onClick={() => set("timezone", localZone)}>
                Use {localZone}
              </Button>
            ) : null}
          </SettingRow>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          icon={<Moon aria-hidden />}
          title="Quiet hours"
          description="Non-urgent notifications are held until quiet hours end. Time-sensitive alerts still come through."
        />
        <CardBody className="divide-y divide-line">
          <SettingRow title="Enable quiet hours" htmlFor="quiet-enabled">
            <Switch
              id="quiet-enabled"
              checked={draft.quietHours.enabled}
              onChange={(enabled) => setIn("quietHours", { enabled })}
            />
          </SettingRow>
          <SettingRow
            title="From – until"
            htmlFor="quiet-start"
            description={
              errors.quietStart || errors.quietEnd ? (
                <ErrorText>Use HH:MM</ErrorText>
              ) : (
                "Windows may cross midnight, e.g. 22:30 – 07:30."
              )
            }
          >
            <Input
              id="quiet-start"
              type="time"
              value={draft.quietHours.start}
              disabled={!draft.quietHours.enabled}
              onChange={(e) => setIn("quietHours", { start: e.target.value.slice(0, 5) })}
              aria-invalid={errors.quietStart ? true : undefined}
              className="w-28 tabular"
            />
            <span className="text-ink-3">–</span>
            <Input
              id="quiet-end"
              type="time"
              aria-label="Quiet hours end"
              value={draft.quietHours.end}
              disabled={!draft.quietHours.enabled}
              onChange={(e) => setIn("quietHours", { end: e.target.value.slice(0, 5) })}
              aria-invalid={errors.quietEnd ? true : undefined}
              className="w-28 tabular"
            />
          </SettingRow>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          icon={<BellRing aria-hidden />}
          title="Notifications"
          description="Which sources may notify you, and how often."
        />
        <CardBody className="divide-y divide-line">
          <SettingRow
            title="Maximum per hour"
            htmlFor="max-per-hour"
            description={
              errors.maxPerHour ? (
                <ErrorText>{errors.maxPerHour}</ErrorText>
              ) : (
                "Cap for rule and agent nudges in any rolling hour. System alerts are never capped."
              )
            }
          >
            <NumberInput
              id="max-per-hour"
              value={draft.notifications.maxPerHour}
              min={0}
              max={60}
              invalid={!!errors.maxPerHour}
              onChange={(maxPerHour) => setIn("notifications", { maxPerHour })}
            />
          </SettingRow>
          {(
            [
              ["system", "System alerts", "Pendant disconnected, low battery, test notifications."],
              ["rule", "Rules", "Notifications from rules you define."],
              ["agent", "Agent", "Proactive nudges from the assistant."],
            ] as const
          ).map(([key, title, description]) => (
            <SettingRow key={key} title={title} description={description} htmlFor={`src-${key}`}>
              <Switch
                id={`src-${key}`}
                checked={draft.notifications.sources[key]}
                onChange={(on) =>
                  setIn("notifications", {
                    sources: { ...draft.notifications.sources, [key]: on },
                  })
                }
              />
            </SettingRow>
          ))}
          <SettingRow
            title="Vibrate the pendant"
            htmlFor="pendant-haptic"
            description="Buzz the Omi when a nudge arrives over the live connection."
          >
            <Switch
              id="pendant-haptic"
              checked={draft.notifications.pendantHaptic}
              onChange={(pendantHaptic) => setIn("notifications", { pendantHaptic })}
            />
          </SettingRow>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          icon={<MousePointerClick aria-hidden />}
          title="Pendant button"
          description="Actions run on the phone, so they work even while offline."
        />
        <CardBody className="divide-y divide-line">
          {(
            [
              ["tap", "Single tap"],
              ["doubleTap", "Double tap"],
              ["hold", "Press and hold"],
            ] as const
          ).map(([key, title]) => (
            <SettingRow key={key} title={title} htmlFor={`button-${key}`}>
              <Select
                id={`button-${key}`}
                value={draft.button[key]}
                onChange={(e) => setIn("button", { [key]: e.target.value as ButtonAction })}
                className="w-60"
              >
                {buttonActions.map((action) => (
                  <option key={action} value={action}>
                    {buttonActionLabel[action]}
                  </option>
                ))}
              </Select>
            </SettingRow>
          ))}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          icon={<Siren aria-hidden />}
          title="Alerts"
          description="System notifications about your capture setup."
        />
        <CardBody className="divide-y divide-line">
          <SettingRow
            title="Pendant disconnected"
            htmlFor="disconnected-after"
            description={
              errors.disconnected ? (
                <ErrorText>{errors.disconnected}</ErrorText>
              ) : (
                "Alert when no audio has arrived for this long after the pendant was streaming."
              )
            }
          >
            <NumberInput
              id="disconnected-after"
              value={draft.alerts.disconnectedAfterMin}
              min={1}
              max={240}
              suffix="min"
              invalid={!!errors.disconnected}
              onChange={(disconnectedAfterMin) => setIn("alerts", { disconnectedAfterMin })}
            />
          </SettingRow>
          <SettingRow
            title="Low battery"
            htmlFor="low-battery"
            description={
              errors.lowBattery ? (
                <ErrorText>{errors.lowBattery}</ErrorText>
              ) : (
                "Alert when the pendant battery drops to this level."
              )
            }
          >
            <NumberInput
              id="low-battery"
              value={draft.alerts.lowBatteryPercent}
              min={0}
              max={100}
              suffix="%"
              invalid={!!errors.lowBattery}
              onChange={(lowBatteryPercent) => setIn("alerts", { lowBatteryPercent })}
            />
          </SettingRow>
        </CardBody>
      </Card>

      <div className="sticky bottom-4 z-20 flex justify-end">
        <div className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2 shadow-pop">
          {dirty ? (
            <span className="text-[13px] text-ink-2">
              {valid ? "Unsaved changes" : "Fix the highlighted fields"}
            </span>
          ) : savedAt ? (
            <span className="inline-flex items-center gap-1.5 text-[13px] text-good-ink">
              <Check className="size-4" aria-hidden /> Saved
            </span>
          ) : (
            <span className="text-[13px] text-ink-3">All changes saved</span>
          )}
          <Button
            variant="ghost"
            disabled={!dirty || save.isPending}
            onClick={() => setDraft(base)}
          >
            Discard
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!dirty || !valid}
            loading={save.isPending}
          >
            Save changes
          </Button>
        </div>
      </div>
    </form>
  );
}
