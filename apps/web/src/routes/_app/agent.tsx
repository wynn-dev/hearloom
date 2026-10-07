import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Bot, Copy, KeyRound, Trash2, Webhook } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { RelTime } from "../../components/bits";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader, PageHeader } from "../../components/ui/card";
import { ConfirmButton } from "../../components/ui/dialog";
import { Field, Input } from "../../components/ui/input";
import { EmptyState, ErrorNotice, LoadingRows } from "../../components/ui/misc";
import { useToast } from "../../components/ui/toast";
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
        description="Let an AI agent (e.g. Hermes running Claude) read your memory and tidy up your episodes over MCP."
      />
      <div className="flex flex-col gap-4">
        <Tokens />
        <WebhookCard />
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
        description="Tokens for the MCP endpoint. A token lets the agent search and read your timeline, and title, summarize, split, merge and re-classify episodes (never undoing your own edits)."
      />
      <CardBody className="flex flex-col gap-4">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({ name });
          }}
        >
          <Field label="Name" htmlFor={nameId} className="w-56">
            <Input id={nameId} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
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
        <HermesSnippet />
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
  return (
    <Card>
      <CardHeader
        icon={<Webhook aria-hidden />}
        title="Webhook"
        description="Where Hearloom sends events for the agent, e.g. a Hermes webhook route. Signed with Standard Webhooks headers (webhook-id, webhook-timestamp, webhook-signature); use the same secret as the route. A whsec_ secret is a base64 key."
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
        </div>
      </CardBody>
    </Card>
  );
}

function HermesSnippet() {
  const snippet = `mcp_servers:
  hearloom:
    url: ${location.origin}/mcp
    headers:
      Authorization: "Bearer \${HEARLOOM_MCP_TOKEN}"`;
  return (
    <div className="flex flex-col gap-2 text-[13px] text-ink-2">
      <p>
        Connect Hermes: add Hearloom as a Streamable-HTTP MCP server in ~/.hermes/config.yaml, with
        the token in HEARLOOM_MCP_TOKEN. Run Hermes isolated (Docker or a separate macOS user):
        transcripts are untrusted input.
      </p>
      <pre className="overflow-x-auto rounded-md bg-surface-2 p-3 font-mono text-xs leading-relaxed">
        {snippet}
      </pre>
    </div>
  );
}
