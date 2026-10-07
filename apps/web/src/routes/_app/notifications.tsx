import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { BellOff, Send } from "lucide-react";
import { useMemo } from "react";
import { NotificationRow, SendTestForm } from "../../components/notifications";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader, PageHeader } from "../../components/ui/card";
import { EmptyState, ErrorNotice, LoadingRows } from "../../components/ui/misc";
import { statusLabel, statusTone } from "../../lib/labels";
import { useTimeZone } from "../../lib/me";
import { orpc } from "../../lib/orpc";

export const Route = createFileRoute("/_app/notifications")({
  component: NotificationsPage,
});

const PAGE = 50;

function NotificationsPage() {
  const tz = useTimeZone() ?? "UTC";
  const list = useInfiniteQuery(
    orpc.notifications.list.infiniteOptions({
      input: (before: Date | undefined) => ({ limit: PAGE, before }),
      initialPageParam: undefined,
      getNextPageParam: (last) =>
        last.length === PAGE ? last[last.length - 1]?.createdAt : undefined,
    }),
  );

  const items = useMemo(() => list.data?.pages.flat() ?? [], [list.data]);
  const counts = useMemo(() => {
    const out = new Map<keyof typeof statusLabel, number>();
    for (const n of items) out.set(n.status, (out.get(n.status) ?? 0) + 1);
    return out;
  }, [items]);

  return (
    <>
      <PageHeader
        title="Notifications"
        description="Every agent notification and alert, with how it was delivered and why."
      />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card>
          <CardHeader
            title="History"
            description={items.length > 0 ? `${items.length} loaded` : undefined}
            actions={
              <div className="hidden flex-wrap gap-1 sm:flex">
                {[...counts].map(([status, count]) => (
                  <Badge key={status} tone={statusTone[status]}>
                    {statusLabel[status]} {count}
                  </Badge>
                ))}
              </div>
            }
          />
          {list.error ? (
            <ErrorNotice error={list.error} onRetry={() => void list.refetch()} className="m-4" />
          ) : null}
          {list.isPending ? (
            <LoadingRows rows={6} />
          ) : items.length === 0 ? (
            <EmptyState icon={<BellOff />} title="No notifications yet">
              Alerts (pendant disconnected, low battery) and agent notifications will show up here.
              Send a test to check delivery.
            </EmptyState>
          ) : (
            <>
              <div className="divide-y divide-line">
                {items.map((n) => (
                  <NotificationRow key={n.id} n={n} tz={tz} />
                ))}
              </div>
              {list.hasNextPage ? (
                <div className="flex justify-center border-t border-line p-3">
                  <Button
                    size="sm"
                    loading={list.isFetchingNextPage}
                    onClick={() => void list.fetchNextPage()}
                  >
                    Load more
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </Card>

        <Card className="lg:sticky lg:top-6">
          <CardHeader icon={<Send aria-hidden />} title="Send a test" />
          <CardBody>
            <SendTestForm />
            <p className="mt-3 text-xs text-ink-3">
              Tests are time-sensitive system notifications: they ring even during quiet hours and
              are recorded with their delivery result.
            </p>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
