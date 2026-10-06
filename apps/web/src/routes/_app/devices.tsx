import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Bluetooth, Smartphone, Trash2 } from "lucide-react";
import { BatteryMeter, RelTime } from "../../components/bits";
import { Badge } from "../../components/ui/badge";
import { Card, CardHeader, PageHeader } from "../../components/ui/card";
import { ConfirmButton } from "../../components/ui/dialog";
import { Dot, EmptyState, ErrorNotice, LoadingRows } from "../../components/ui/misc";
import { useToast } from "../../components/ui/toast";
import { useMe, useTimeZone } from "../../lib/me";
import { orpc } from "../../lib/orpc";
import { useNow } from "../../lib/time";

export const Route = createFileRoute("/_app/devices")({
  component: DevicesPage,
});

function DevicesPage() {
  return (
    <>
      <PageHeader
        title="Devices"
        description="Phones that forward audio and receive notifications, and the pendants they carry."
      />
      <div className="flex flex-col gap-4">
        <PhonesTable />
        <WearablesTable />
      </div>
    </>
  );
}

const th = "px-3 py-2 font-medium first:pl-4 last:pr-4";
const td = "px-3 py-2.5 first:pl-4 last:pr-4";

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
        toast({ tone: "good", title: "Phone removed" });
      },
    }),
  );

  return (
    <Card>
      <CardHeader
        icon={<Smartphone aria-hidden />}
        title="Phones"
        description="Removing a phone stops push delivery to it; it re-registers on its next sign-in."
      />
      {phones.error ? (
        <ErrorNotice error={phones.error} onRetry={() => void phones.refetch()} className="m-4" />
      ) : null}
      {phones.isPending ? (
        <LoadingRows />
      ) : phones.data?.length === 0 ? (
        <EmptyState title="No phones registered">
          Install the Hearloom iOS app and sign in with this account.
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
                      description="The phone stops receiving notifications. Audio it already uploaded is kept. If the app is still signed in, it registers again next time it connects."
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
