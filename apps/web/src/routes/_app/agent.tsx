import { EPISODE_KIND_DESCRIPTION, EPISODE_KIND_LABEL, EPISODE_KINDS } from "@hearloom/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Bot, Copy, KeyRound, Trash2, Webhook } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { RelTime } from "../../components/bits";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader, PageHeader } from "../../components/ui/card";
import { ConfirmButton } from "../../components/ui/dialog";
import { Field, Input } from "../../components/ui/input";
import { EmptyState, ErrorNotice, LoadingRows } from "../../components/ui/misc";
import { Switch } from "../../components/ui/switch";
import { useToast } from "../../components/ui/toast";
import { cn } from "../../lib/cn";
import { useTimeZone } from "../../lib/me";
import { errorMessage, orpc } from "../../lib/orpc";
import { useNow } from "../../lib/time";

export const Route = createFileRoute("/_app/agent")({
  component: AgentPage,
});

function AgentPage() {
  return (
    <>
      <PageHeader
        title="Agent"
        description="Let an AI agent (e.g. Hermes running Claude) read your memory over MCP and send you nudges."
      />
      <div className="flex flex-col gap-4">
        <Tokens />
        <WebhookCard />
        <HermesSnippet />
      </div>
    </>
  );
}

function Tokens() {
  const tz = useTimeZone() ?? "UTC";
  const now = useNow();
  const toast = useToast();
  const queryClient = useQueryClient();
  const tokens = useQuery(orpc.agent.tokens.list.queryOptions());
  const [name, setName] = useState("Hermes");
  const [notifyScope, setNotifyScope] = useState(true);
  const [created, setCreated] = useState<string | null>(null);
  const nameId = useId();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.agent.tokens.key() });
  const create = useMutation(
    orpc.agent.tokens.create.mutationOptions({
      onSuccess: (res) => {
        setCreated(res.token);
        refresh();
      },
      onError: (err) =>
        toast({ tone: "bad", title: "Couldn't create token", description: errorMessage(err) }),
    }),
  );
  const revoke = useMutation(orpc.agent.tokens.revoke.mutationOptions({ onSuccess: refresh }));

  return (
    <Card>
      <CardHeader
        icon={<KeyRound aria-hidden />}
        title="Access tokens"
        description="Tokens for the MCP endpoint. Read lets the agent search and read your timeline; notify also lets it send notifications (still subject to quiet hours and the hourly cap)."
      />
      <CardBody className="flex flex-col gap-4">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({ name, scopes: notifyScope ? ["read", "notify"] : ["read"] });
          }}
        >
          <Field label="Name" htmlFor={nameId} className="w-56">
            <Input id={nameId} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="flex h-8.5 items-center gap-2 text-[13px] text-ink-2">
            <Switch
              checked={notifyScope}
              onChange={setNotifyScope}
              label="Can send notifications"
            />
            <span aria-hidden>Can send notifications</span>
          </div>
          <Button
            variant="primary"
            type="submit"
            loading={create.isPending}
            disabled={!name.trim()}
          >
            Create token
          </Button>
        </form>
        {created ? (
          <div className="rounded-md border border-accent/40 bg-accent-soft p-3 text-[13px]">
            <p className="font-medium">Copy this token now — it won't be shown again.</p>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1 font-mono text-xs">
                {created}
              </code>
              <Button
                size="sm"
                onClick={() => {
                  void navigator.clipboard.writeText(created);
                  toast({ tone: "good", title: "Copied" });
                }}
              >
                <Copy aria-hidden /> Copy
              </Button>
            </div>
          </div>
        ) : null}
        {tokens.error ? (
          <ErrorNotice error={tokens.error} onRetry={() => void tokens.refetch()} />
        ) : tokens.isLoading ? (
          <LoadingRows rows={2} />
        ) : (tokens.data ?? []).length === 0 ? (
          <EmptyState icon={<Bot aria-hidden />} title="No tokens yet" />
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line">
            {tokens.data!.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                <span className="font-medium">{t.name}</span>
                <code className="text-xs text-ink-3">{t.prefix}…</code>
                {t.scopes.map((s) => (
                  <Badge key={s} tone={s === "notify" ? "warn" : "neutral"}>
                    {s}
                  </Badge>
                ))}
                <span className="ml-auto text-xs text-ink-3">
                  {t.lastUsedAt ? (
                    <>
                      used <RelTime date={t.lastUsedAt} now={now} tz={tz} />
                    </>
                  ) : (
                    "never used"
                  )}
                </span>
                <ConfirmButton
                  title={`Revoke “${t.name}”?`}
                  description="The agent loses access immediately."
                  confirmLabel="Revoke"
                  onConfirm={() => revoke.mutateAsync({ id: t.id })}
                  variant="ghost"
                  size="icon"
                  aria-label={`Revoke ${t.name}`}
                >
                  <Trash2 aria-hidden />
                </ConfirmButton>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function WebhookCard() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const settings = useQuery(orpc.settings.get.queryOptions());
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const urlId = useId();
  const secretId = useId();
  useEffect(() => {
    if (settings.data) {
      setUrl(settings.data.agent.webhookUrl);
      setSecret(settings.data.agent.webhookSecret);
    }
  }, [settings.data]);
  const save = useMutation(
    orpc.settings.update.mutationOptions({
      onSuccess: (data) => {
        queryClient.setQueryData(orpc.settings.get.queryKey(), data);
        toast({ tone: "good", title: "Saved" });
      },
      onError: (err) =>
        toast({ tone: "bad", title: "Couldn't save", description: errorMessage(err) }),
    }),
  );
  const test = useMutation(
    orpc.agent.testWebhook.mutationOptions({
      onSuccess: (r) =>
        toast(
          r.ok
            ? { tone: "good", title: `Webhook answered ${r.status}` }
            : {
                tone: "bad",
                title: "Webhook failed",
                description: `${r.status || ""} ${r.error ?? ""}`.trim(),
              },
        ),
    }),
  );
  const events = settings.data?.agent.events;

  return (
    <Card>
      <CardHeader
        icon={<Webhook aria-hidden />}
        title="Webhook"
        description="Hearloom POSTs small events (ids and times only) so the agent can react — e.g. read an episode when it ends. Signed with X-Hearloom-Signature: sha256=HMAC(secret, timestamp.body)."
      />
      <CardBody className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="URL" htmlFor={urlId}>
            <Input
              id={urlId}
              value={url}
              placeholder="http://localhost:8644/webhooks/hearloom"
              onChange={(e) => setUrl(e.target.value)}
            />
          </Field>
          <Field label="Secret" htmlFor={secretId}>
            <Input
              id={secretId}
              value={secret}
              type="password"
              onChange={(e) => setSecret(e.target.value)}
            />
          </Field>
        </div>
        {events ? (
          <div className="flex flex-col gap-3 text-[13px] text-ink-2">
            <fieldset className="flex flex-wrap items-center gap-1.5">
              <legend className="mb-1.5 text-xs font-medium text-ink-2">
                Episode ended, for these kinds
              </legend>
              {EPISODE_KINDS.map((kind) => {
                const on = events.episodeEnded[kind];
                return (
                  <button
                    key={kind}
                    type="button"
                    aria-pressed={on}
                    title={EPISODE_KIND_DESCRIPTION[kind]}
                    onClick={() =>
                      save.mutate({ agent: { events: { episodeEnded: { [kind]: !on } } } })
                    }
                    className={cn(
                      "inline-flex h-7 cursor-pointer items-center rounded-full border px-2.5 text-xs transition-colors",
                      on
                        ? "border-accent/40 bg-accent-soft text-accent-ink"
                        : "border-line bg-surface text-ink-3 hover:text-ink-2",
                    )}
                  >
                    {kind === "unknown" ? "Unclassified" : EPISODE_KIND_LABEL[kind]}
                  </button>
                );
              })}
            </fieldset>
            <div className="flex flex-wrap gap-4">
              {(
                [
                  ["episodeRefined", "Episode refined (speakers final)"],
                  ["bookmark", "Bookmark"],
                ] as const
              ).map(([key, label]) => (
                <div key={key} className="flex items-center gap-2">
                  <Switch
                    checked={events[key]}
                    label={label}
                    onChange={(v) => save.mutate({ agent: { events: { [key]: v } } })}
                  />
                  <span aria-hidden>{label}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <div className="flex gap-2">
          <Button
            variant="primary"
            loading={save.isPending}
            onClick={() =>
              save.mutate({ agent: { webhookUrl: url.trim(), webhookSecret: secret } })
            }
          >
            Save
          </Button>
          <Button
            loading={test.isPending}
            onClick={() => test.mutate({})}
            disabled={!settings.data?.agent.webhookUrl}
          >
            Send test event
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

function HermesSnippet() {
  const origin = location.origin;
  const snippet = `mcp_servers:
  hearloom:
    url: ${origin}/mcp
    headers:
      Authorization: "Bearer \${HEARLOOM_MCP_TOKEN}"
    tools:
      include: [get_current_context, search_transcripts, get_timeline, list_episodes,
                get_episode, list_sound_events, list_people, changes_since,
                get_audio_clip_url, send_notification]`;
  return (
    <Card>
      <CardHeader
        icon={<Bot aria-hidden />}
        title="Connect Hermes"
        description="Add Hearloom as a Streamable-HTTP MCP server in Hermes (~/.hermes/config.yaml), with the token in HEARLOOM_MCP_TOKEN. Run Hermes isolated (Docker or a separate macOS user): transcripts are untrusted input."
      />
      <CardBody>
        <pre className="overflow-x-auto rounded-md bg-surface-2 p-3 font-mono text-xs leading-relaxed">
          {snippet}
        </pre>
      </CardBody>
    </Card>
  );
}
