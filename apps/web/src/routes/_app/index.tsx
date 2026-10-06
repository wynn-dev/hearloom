import type { LiveStatus } from "@hearloom/api";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Bell, Bluetooth, Mic, MicOff, Radio, Smartphone } from "lucide-react";
import { BatteryMeter, RelTime, Stat } from "../../components/bits";
import { NotificationRow, SendTestButton } from "../../components/notifications";
import { Badge } from "../../components/ui/badge";
import { Card, CardHeader, PageHeader } from "../../components/ui/card";
import { Dot, EmptyState, ErrorNotice, LoadingRows } from "../../components/ui/misc";
import { codecLabel } from "../../lib/labels";
import { useMe, useTimeZone } from "../../lib/me";
import { orpc } from "../../lib/orpc";
import { formatDuration, formatTime, useNow } from "../../lib/time";

export const Route = createFileRoute("/_app/")({
  component: NowPage,
});

function frameMs(codec: number): number {
  return codec === 20 ? 10 : 20;
}

function NowPage() {
  const tz = useTimeZone() ?? "UTC";
  const now = useNow(10_000);
  // "live" depends on wall-clock time, so poll gently on top of realtime invalidations.
  const status = useQuery({ ...orpc.status.live.queryOptions(), refetchInterval: 30_000 });

  return (
    <>
      <PageHeader
        title="Now"
        description="Live capture status across your phones and pendants."
        actions={<SendTestButton />}
      />
      {status.error ? (
        <ErrorNotice error={status.error} onRetry={() => void status.refetch()} className="mb-4" />
      ) : null}
      {status.data ? (
        <div className="flex flex-col gap-4">
          <CaptureSummary status={status.data} now={now} tz={tz} />
          <div className="grid gap-4 lg:grid-cols-2">
            <PhonesCard status={status.data} now={now} tz={tz} />
            <WearablesCard status={status.data} now={now} tz={tz} />
          </div>
          <StreamsCard status={status.data} now={now} tz={tz} />
          <RecentNotifications tz={tz} />
        </div>
      ) : status.isPending ? (
        <Card>
          <LoadingRows rows={5} />
        </Card>
      ) : null}
    </>
  );
}

function CaptureSummary({ status, now, tz }: { status: LiveStatus; now: number; tz: string }) {
  const live = status.streams.filter((s) => s.live);
  const lastFrame = status.streams.reduce<Date | null>(
    (acc, s) => (s.lastFrameAt && (!acc || s.lastFrameAt > acc) ? s.lastFrameAt : acc),
    null,
  );
  const online = status.phones.filter((p) => p.online).length;
  const wearable = status.wearables[0];
  const current = live[0];

  return (
    <Card className="grid gap-4 p-4 sm:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]">
      <div className="flex min-w-0 items-center gap-3">
        <span
          className={
            current
              ? "flex size-10 shrink-0 items-center justify-center rounded-full bg-good-soft text-good-ink"
              : "flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-2 text-ink-3"
          }
        >
          {current ? (
            <Mic className="size-5" aria-hidden />
          ) : (
            <MicOff className="size-5" aria-hidden />
          )}
        </span>
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-base font-semibold">
            {current ? (
              <>
                <Dot tone="good" pulse /> Recording
              </>
            ) : (
              "Not recording"
            )}
          </p>
          <p className="truncate text-[13px] text-ink-3">
            {current ? (
              <>
                {current.wearableName ?? "Pendant"} · since {formatTime(current.startedAt, tz)} (
                {formatDuration(now - current.startedAt.getTime())})
              </>
            ) : lastFrame ? (
              <>
                Last audio <RelTime date={lastFrame} now={now} tz={tz} />
              </>
            ) : (
              "No audio received yet"
            )}
          </p>
        </div>
      </div>
      <Stat
        label="Phones online"
        value={`${online} / ${status.phones.length}`}
        hint={online === 0 && status.phones.length > 0 ? "No live connection" : undefined}
      />
      <Stat
        label="Pendant battery"
        value={
          wearable?.batteryLevel !== null && wearable?.batteryLevel !== undefined
            ? `${wearable.batteryLevel}%`
            : "—"
        }
        hint={wearable?.name}
      />
      <Stat
        label="Live streams"
        value={live.length}
        hint={`${status.streams.length} in last 24 h`}
      />
    </Card>
  );
}

function PhonesCard({ status, now, tz }: { status: LiveStatus; now: number; tz: string }) {
  return (
    <Card>
      <CardHeader
        icon={<Smartphone aria-hidden />}
        title="Phones"
        actions={
          <Link to="/devices" className="text-xs text-accent-ink hover:underline">
            Manage
          </Link>
        }
      />
      {status.phones.length === 0 ? (
        <EmptyState title="No phones yet">
          Sign in from the Hearloom iOS app to register this account's phone.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {status.phones.map((p) => (
            <li key={p.id} className="flex items-center gap-3 px-4 py-2.5">
              <Dot tone={p.online ? "good" : "muted"} pulse={p.online} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">
                  {p.name}
                  <span className="ml-2 font-normal text-ink-3">
                    {p.online ? "online" : "offline"}
                  </span>
                </p>
                <p className="truncate text-xs text-ink-3">
                  {[
                    p.model,
                    p.osVersion && `iOS ${p.osVersion}`,
                    p.appVersion && `app ${p.appVersion}`,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "Unknown device"}
                  {" · seen "}
                  <RelTime date={p.lastSeenAt} now={now} tz={tz} />
                </p>
              </div>
              {!p.pushEnabled ? (
                <Badge>Push off</Badge>
              ) : p.hasPushToken ? (
                <Badge tone="good">Push · {p.apnsEnv ?? "?"}</Badge>
              ) : (
                <Badge tone="warn">No push token</Badge>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function WearablesCard({ status, now, tz }: { status: LiveStatus; now: number; tz: string }) {
  const me = useMe();
  const low = me.data?.settings.alerts.lowBatteryPercent ?? 15;
  return (
    <Card>
      <CardHeader icon={<Bluetooth aria-hidden />} title="Pendants" />
      {status.wearables.length === 0 ? (
        <EmptyState title="No pendant seen yet">
          Pair your Omi in the iOS app; it shows up here once it streams.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {status.wearables.map((w) => (
            <li key={w.id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{w.name}</p>
                <p className="truncate text-xs text-ink-3">
                  {[w.model, w.firmware && `fw ${w.firmware}`].filter(Boolean).join(" · ") ||
                    "Unknown model"}
                  {" · seen "}
                  <RelTime date={w.lastSeenAt} now={now} tz={tz} />
                </p>
              </div>
              <BatteryMeter level={w.batteryLevel} low={low} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function StreamsCard({ status, now, tz }: { status: LiveStatus; now: number; tz: string }) {
  const phoneName = new Map(status.phones.map((p) => [p.id, p.name]));
  return (
    <Card>
      <CardHeader
        icon={<Radio aria-hidden />}
        title="Recent streams"
        description="Capture sessions from the last 24 hours"
      />
      {status.streams.length === 0 ? (
        <EmptyState title="No streams in the last 24 hours" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="text-xs text-ink-3">
              <tr className="border-b border-line">
                <th className="px-4 py-2 font-medium">Pendant</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Started</th>
                <th className="px-3 py-2 font-medium">Last frame</th>
                <th className="px-3 py-2 text-right font-medium">Audio</th>
                <th className="px-3 py-2 text-right font-medium">Frames</th>
                <th className="px-4 py-2 font-medium">Codec</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {status.streams.map((s) => (
                <tr key={s.id} className="align-middle">
                  <td className="px-4 py-2">
                    <p className="font-medium">{s.wearableName ?? "Unknown pendant"}</p>
                    <p className="text-xs text-ink-3">
                      via {phoneName.get(s.phoneId) ?? "unknown phone"}
                    </p>
                  </td>
                  <td className="px-3 py-2">
                    {s.live ? (
                      <Badge tone="good" dot>
                        Live
                      </Badge>
                    ) : s.endedAt ? (
                      <Badge>Ended</Badge>
                    ) : (
                      <Badge tone="warn" title="Open, but no audio in the last 2 minutes">
                        Idle
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 tabular whitespace-nowrap text-ink-2">
                    {formatTime(s.startedAt, tz)}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-ink-2">
                    <RelTime date={s.lastFrameAt} now={now} tz={tz} />
                  </td>
                  <td className="px-3 py-2 text-right tabular whitespace-nowrap text-ink-2">
                    {formatDuration(s.framesReceived * frameMs(s.codec))}
                  </td>
                  <td className="px-3 py-2 text-right tabular text-ink-2">
                    {s.framesReceived.toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-ink-3">{codecLabel(s.codec)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function RecentNotifications({ tz }: { tz: string }) {
  const list = useQuery(orpc.notifications.list.queryOptions({ input: { limit: 5 } }));
  return (
    <Card>
      <CardHeader
        icon={<Bell aria-hidden />}
        title="Latest notifications"
        actions={
          <Link to="/notifications" className="text-xs text-accent-ink hover:underline">
            View all
          </Link>
        }
      />
      {list.error ? <ErrorNotice error={list.error} className="m-4" /> : null}
      {list.data ? (
        list.data.length === 0 ? (
          <EmptyState title="No notifications yet">
            Send a test notification to check delivery to your phone.
          </EmptyState>
        ) : (
          <div className="divide-y divide-line">
            {list.data.map((n) => (
              <NotificationRow key={n.id} n={n} tz={tz} compact />
            ))}
          </div>
        )
      ) : list.isPending ? (
        <LoadingRows />
      ) : null}
    </Card>
  );
}
