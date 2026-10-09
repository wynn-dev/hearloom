import type { DeviceSession } from "@hearloom/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Bluetooth, Globe, KeyRound, Link2, LogOut, Smartphone, Trash2 } from "lucide-react";
import { useState } from "react";
import { BatteryMeter, RelTime } from "../../components/bits";
import { LinkDeviceDialog } from "../../components/link-device";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardHeader, PageHeader } from "../../components/ui/card";
import { ConfirmButton } from "../../components/ui/dialog";
import { Dot, EmptyState, ErrorNotice, LoadingRows } from "../../components/ui/misc";
import { useToast } from "../../components/ui/toast";
import { authClient } from "../../lib/auth";
import { useMe, useTimeZone } from "../../lib/me";
import { orpc } from "../../lib/orpc";
import { formatDate, formatDateTime, formatDayRelative, useNow } from "../../lib/time";

export const Route = createFileRoute("/_app/devices")({
  component: DevicesPage,
});

function DevicesPage() {
  const [linking, setLinking] = useState(false);
  return (
    <>
      <PageHeader
        title="Devices"
        description="Where you're signed in, the phones that forward audio and receive notifications, and the pendants they carry."
        actions={
          <Button variant="primary" onClick={() => setLinking(true)}>
            <Link2 aria-hidden />
            Link a device
          </Button>
        }
      />
      <LinkDeviceDialog open={linking} onClose={() => setLinking(false)} />
      <div className="flex flex-col gap-4">
        <SessionsTable onLink={() => setLinking(true)} />
        <PhonesTable />
        <WearablesTable />
      </div>
    </>
  );
}

const th = "px-3 py-2 font-medium first:pl-4 last:pr-4";
const td = "px-3 py-2.5 first:pl-4 last:pr-4";

function revokeCopy(s: DeviceSession): string {
  if (s.current) {
    return "This browser is signed out now. To sign in again, link it from another signed-in device (or use a password, if you have one).";
  }
  if (s.kind === "app") {
    return "The app is signed out immediately and stops uploading until it's linked again. Audio already uploaded is kept; audio not yet sent waits on the phone.";
  }
  return "That browser is signed out immediately.";
}

function SessionsTable({ onLink }: { onLink: () => void }) {
  const tz = useTimeZone() ?? "UTC";
  const now = useNow(60_000);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const session = authClient.useSession();
  const toast = useToast();
  const sessions = useQuery(orpc.sessions.list.queryOptions());
  const { mutateAsync: revokeSession } = useMutation(orpc.sessions.revoke.mutationOptions());
  // Only shown when the server records addresses (it trusts no forwarding header, so often none).
  const showIp = sessions.data?.some((s) => s.ipAddress) ?? false;

  const revoke = async (s: DeviceSession) => {
    await revokeSession({ id: s.id });
    if (s.current) {
      // This browser's session is gone: drop its cookie, then leave like Sign out does.
      await authClient.signOut().catch(() => undefined);
      await session.refetch();
      await navigate({ to: "/login" });
      queryClient.clear();
      return;
    }
    void queryClient.invalidateQueries({ queryKey: orpc.sessions.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.phones.key() });
    toast({ tone: "good", title: `${s.name} signed out` });
  };

  return (
    <Card>
      <CardHeader
        icon={<KeyRound aria-hidden />}
        title="Signed-in devices"
        description="Every app and browser signed in to your account. Signing one out takes effect at once."
      />
      {sessions.error ? (
        <ErrorNotice
          error={sessions.error}
          onRetry={() => void sessions.refetch()}
          className="m-4"
        />
      ) : null}
      {sessions.isPending ? (
        <LoadingRows />
      ) : sessions.data?.length === 0 ? (
        <EmptyState title="No signed-in devices">
          <button
            type="button"
            onClick={onLink}
            className="cursor-pointer text-accent-ink underline underline-offset-2"
          >
            Link a device
          </button>
        </EmptyState>
      ) : sessions.data ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="text-xs text-ink-3">
              <tr className="border-b border-line">
                <th className={th}>Device</th>
                {showIp ? <th className={th}>IP address</th> : null}
                <th className={th}>Signed in</th>
                <th className={th}>
                  <span title="Recorded about once a day">Last active</span>
                </th>
                <th className={th}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {sessions.data.map((s) => {
                const Icon = s.kind === "app" ? Smartphone : Globe;
                return (
                  <tr key={s.id}>
                    <td className={td}>
                      <div className="flex items-center gap-2.5">
                        <Icon className="size-4 shrink-0 text-ink-3" aria-hidden />
                        <div className="min-w-0">
                          <p className="flex flex-wrap items-center gap-2 font-medium">
                            {s.name}
                            {s.current ? <Badge tone="accent">This browser</Badge> : null}
                          </p>
                          <p className="text-xs text-ink-3">
                            {s.kind === "app" ? (s.detail ?? "Hearloom app") : "Browser"}
                          </p>
                        </div>
                      </div>
                    </td>
                    {showIp ? (
                      <td className={`${td} text-ink-2 tabular`}>{s.ipAddress ?? "—"}</td>
                    ) : null}
                    <td className={`${td} whitespace-nowrap text-ink-2`}>
                      <time
                        dateTime={s.createdAt.toISOString()}
                        title={formatDateTime(s.createdAt, tz)}
                      >
                        {formatDate(s.createdAt, tz)}
                      </time>
                    </td>
                    <td className={`${td} whitespace-nowrap text-ink-2`}>
                      <time
                        dateTime={s.lastActiveAt.toISOString()}
                        title="Recorded about once a day"
                      >
                        {s.current ? "Now" : formatDayRelative(s.lastActiveAt, now, tz)}
                      </time>
                    </td>
                    <td className={`${td} text-right`}>
                      <ConfirmButton
                        title={s.current ? "Sign out this browser?" : `Sign out ${s.name}?`}
                        description={revokeCopy(s)}
                        confirmLabel="Sign out"
                        onConfirm={() => revoke(s)}
                      >
                        <LogOut aria-hidden />
                        Sign out
                      </ConfirmButton>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}

function PhonesTable() {
  const tz = useTimeZone() ?? "UTC";
  const now = useNow();
  const queryClient = useQueryClient();
  const toast = useToast();
  const phones = useQuery(orpc.phones.list.queryOptions());
  const remove = useMutation(
    orpc.phones.remove.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.phones.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.status.key() });
        void queryClient.invalidateQueries({ queryKey: orpc.sessions.key() });
        toast({ tone: "good", title: "Phone removed" });
      },
    }),
  );

  return (
    <Card>
      <CardHeader
        icon={<Smartphone aria-hidden />}
        title="Phones"
        description="Removing a phone signs its app out and stops push delivery to it."
      />
      {phones.error ? (
        <ErrorNotice error={phones.error} onRetry={() => void phones.refetch()} className="m-4" />
      ) : null}
      {phones.isPending ? (
        <LoadingRows />
      ) : phones.data?.length === 0 ? (
        <EmptyState title="No phones registered">
          Install the Hearloom iOS app, then link it: Link a device, and scan the code with the
          iPhone's Camera.
        </EmptyState>
      ) : phones.data ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="text-xs text-ink-3">
              <tr className="border-b border-line">
                <th className={th}>Phone</th>
                <th className={th}>Connection</th>
                <th className={th}>Push</th>
                <th className={th}>Versions</th>
                <th className={th}>Last seen</th>
                <th className={th}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {phones.data.map((p) => (
                <tr key={p.id}>
                  <td className={td}>
                    <p className="font-medium">{p.name}</p>
                    <p className="text-xs text-ink-3">{p.model ?? "Unknown model"}</p>
                  </td>
                  <td className={td}>
                    <span className="inline-flex items-center gap-2 text-ink-2">
                      <Dot tone={p.online ? "good" : "muted"} />
                      {p.online ? "Online" : "Offline"}
                    </span>
                  </td>
                  <td className={td}>
                    {!p.pushEnabled ? (
                      <Badge>Disabled</Badge>
                    ) : p.hasPushToken ? (
                      <Badge tone="good">Token · {p.apnsEnv ?? "unknown env"}</Badge>
                    ) : (
                      <Badge tone="warn">No token</Badge>
                    )}
                  </td>
                  <td className={`${td} text-xs text-ink-2`}>
                    <p>iOS {p.osVersion ?? "—"}</p>
                    <p className="text-ink-3">app {p.appVersion ?? "—"}</p>
                  </td>
                  <td className={`${td} whitespace-nowrap text-ink-2`}>
                    <RelTime date={p.lastSeenAt} now={now} tz={tz} />
                  </td>
                  <td className={`${td} text-right`}>
                    <ConfirmButton
                      title={`Remove ${p.name}?`}
                      description="Its app is signed out and stops uploading and receiving notifications until it's linked again. Audio already uploaded is kept; audio not yet sent waits on the phone."
                      confirmLabel="Remove phone"
                      onConfirm={() => remove.mutateAsync({ id: p.id })}
                    >
                      <Trash2 aria-hidden />
                      Remove
                    </ConfirmButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}

function WearablesTable() {
  const tz = useTimeZone() ?? "UTC";
  const now = useNow();
  const me = useMe();
  const wearables = useQuery(orpc.wearables.list.queryOptions());
  const low = me.data?.settings.alerts.lowBatteryPercent ?? 15;

  return (
    <Card>
      <CardHeader icon={<Bluetooth aria-hidden />} title="Pendants" />
      {wearables.error ? (
        <ErrorNotice
          error={wearables.error}
          onRetry={() => void wearables.refetch()}
          className="m-4"
        />
      ) : null}
      {wearables.isPending ? (
        <LoadingRows />
      ) : wearables.data?.length === 0 ? (
        <EmptyState title="No pendants yet">
          Pair an Omi in the iOS app. It appears here after its first stream.
        </EmptyState>
      ) : wearables.data ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="text-xs text-ink-3">
              <tr className="border-b border-line">
                <th className={th}>Pendant</th>
                <th className={th}>Model</th>
                <th className={th}>Firmware</th>
                <th className={th}>Battery</th>
                <th className={th}>Last seen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {wearables.data.map((w) => (
                <tr key={w.id}>
                  <td className={`${td} font-medium`}>{w.name}</td>
                  <td className={`${td} text-ink-2`}>{w.model ?? "—"}</td>
                  <td className={`${td} text-ink-2 tabular`}>{w.firmware ?? "—"}</td>
                  <td className={td}>
                    <BatteryMeter level={w.batteryLevel} low={low} />
                  </td>
                  <td className={`${td} whitespace-nowrap text-ink-2`}>
                    <RelTime date={w.lastSeenAt} now={now} tz={tz} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}
