import type { NotificationItem } from "@hearloom/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BellRing, MessageSquareReply } from "lucide-react";
import { type FormEvent, memo, useState } from "react";
import { cn } from "../lib/cn";
import {
  feedbackLabel,
  interruptionLabel,
  type NotificationStatus,
  reasonLabel,
  sourceLabel,
  statusLabel,
  statusTone,
} from "../lib/labels";
import { errorMessage, orpc } from "../lib/orpc";
import { formatDateTime, formatTime } from "../lib/time";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Field, Input, Textarea } from "./ui/input";
import { Switch } from "./ui/switch";
import { useToast } from "./ui/toast";

export function StatusBadge({
  status,
  reason,
}: {
  status: NotificationStatus;
  reason?: string | null;
}) {
  const why = reasonLabel(reason);
  return (
    <Badge tone={statusTone[status]} dot title={why ? `${statusLabel[status]}: ${why}` : undefined}>
      {statusLabel[status]}
      {why ? <span className="font-normal opacity-80">· {why}</span> : null}
    </Badge>
  );
}

function Stamp({ label, date, tz }: { label: string; date: Date | null; tz: string }) {
  if (!date) return null;
  return (
    <span title={date.toISOString()}>
      {label} <span className="tabular text-ink-2">{formatDateTime(date, tz)}</span>
    </span>
  );
}

export const NotificationRow = memo(function NotificationRow({
  n,
  tz,
  compact = false,
}: {
  n: NotificationItem;
  tz: string;
  compact?: boolean;
}) {
  return (
    <article className="flex flex-col gap-1 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <h3 className="min-w-0 flex-1 basis-48 text-[13px] font-semibold text-ink">{n.title}</h3>
        <StatusBadge status={n.status} reason={n.statusReason} />
      </div>
      {n.body ? (
        <p className={cn("text-[13px] text-ink-2", compact && "line-clamp-2")}>{n.body}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
        <span className="inline-flex items-center gap-1.5">
          <Badge>{sourceLabel[n.source]}</Badge>
          <Badge>{n.category}</Badge>
          {compact ? null : (
            <Badge tone={n.interruptionLevel === "time-sensitive" ? "info" : "neutral"}>
              {interruptionLabel[n.interruptionLevel]}
            </Badge>
          )}
        </span>
        {compact ? (
          <span className="tabular" title={formatDateTime(n.createdAt, tz)}>
            {formatTime(n.createdAt, tz)}
          </span>
        ) : (
          <>
            <Stamp label="Created" date={n.createdAt} tz={tz} />
            <Stamp label="Sent" date={n.sentAt} tz={tz} />
            <Stamp label="Delivered" date={n.deliveredAt} tz={tz} />
            <Stamp label="Opened" date={n.openedAt} tz={tz} />
          </>
        )}
      </div>
      {!compact && (n.feedback || n.replyText) ? (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
          {n.feedback ? (
            <Badge tone={n.feedback === "useful" ? "good" : "neutral"}>
              {feedbackLabel[n.feedback]}
            </Badge>
          ) : null}
          {n.replyText ? (
            <span className="inline-flex min-w-0 items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1 text-ink-2">
              <MessageSquareReply className="size-3.5 shrink-0 text-ink-3" aria-hidden />
              <span className="min-w-0">“{n.replyText}”</span>
            </span>
          ) : null}
        </div>
      ) : null}
    </article>
  );
});

function useSendTest() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation(
    orpc.notifications.sendTest.mutationOptions({
      onSuccess: (result) => {
        void queryClient.invalidateQueries({ queryKey: orpc.notifications.key() });
        const ok = result.status === "sent" || result.status === "delivered";
        toast({
          tone: ok ? "good" : result.status === "failed" ? "bad" : "info",
          title: `Test notification ${statusLabel[result.status].toLowerCase()}`,
          description: ok
            ? "Check your phone."
            : "See Notifications for the reason it was not delivered.",
        });
      },
      onError: (error) =>
        toast({ tone: "bad", title: "Could not send", description: errorMessage(error) }),
    }),
  );
}

/** One-click test with the server's default text. Shows the resulting status inline. */
export function SendTestButton() {
  const send = useSendTest();
  return (
    <span className="inline-flex items-center gap-2">
      {send.data ? <StatusBadge status={send.data.status} /> : null}
      <Button loading={send.isPending} onClick={() => send.mutate({})}>
        <BellRing aria-hidden />
        Send test notification
      </Button>
    </span>
  );
}

export function SendTestForm() {
  const send = useSendTest();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [haptic, setHaptic] = useState(true);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    send.mutate({
      title: title.trim() || undefined,
      body: body.trim() || undefined,
      haptic,
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <Field label="Title" htmlFor="test-title">
        <Input
          id="test-title"
          maxLength={120}
          placeholder="Hearloom test"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>
      <Field label="Body" htmlFor="test-body">
        <Textarea
          id="test-body"
          maxLength={500}
          placeholder="If you can read this, notifications work."
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </Field>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="test-haptic" className="text-[13px] text-ink-2">
          Buzz the pendant
        </label>
        <Switch id="test-haptic" checked={haptic} onChange={setHaptic} />
      </div>
      <div className="flex items-center justify-end gap-2">
        {send.data ? <StatusBadge status={send.data.status} /> : null}
        <Button type="submit" variant="primary" loading={send.isPending}>
          <BellRing aria-hidden />
          Send test
        </Button>
      </div>
    </form>
  );
}
