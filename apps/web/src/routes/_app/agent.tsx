import { isValidWebhookSecret } from "@hearloom/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Bot,
  Check,
  Circle,
  Copy,
  ExternalLink,
  Plug,
  RefreshCw,
  Send,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { RelTime } from "../../components/bits";
import { Button, buttonClass } from "../../components/ui/button";
import { Card, CardBody, CardHeader, PageHeader } from "../../components/ui/card";
import { ConfirmButton } from "../../components/ui/dialog";
import { Field, Input } from "../../components/ui/input";
import { EmptyState, ErrorNotice, LoadingRows } from "../../components/ui/misc";
import { useToast } from "../../components/ui/toast";
import { cn } from "../../lib/cn";
import {
  AGENT_SECURITY_DOCS,
  type HermesWhere,
  hermesCommandsSnippet,
  hermesConfigSnippet,
  hermesEnvSnippet,
  hermesWebhookUrl,
  normalizeHost,
  parseHermesWebhookUrl,
} from "../../lib/hermes";
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
        description="Let an AI agent (e.g. Hermes running Claude) read your memory and tidy up your episodes over MCP, and take your “Hey Hermes” voice commands."
      />
      <ConnectHermes />
    </>
  );
}

/**
 * One guided setup: a token, a webhook secret and URL, then the Hermes config filled in with them.
 * The token and a freshly generated secret are shown once, so the copy blocks hold them only then.
 */
function ConnectHermes() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const settings = useQuery(orpc.settings.get.queryOptions());
  const config = useQuery(orpc.agent.config.queryOptions());
  const tokens = useQuery(orpc.agent.tokens.list.queryOptions());
  const [token, setToken] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
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

  if (settings.error) {
    return <ErrorNotice error={settings.error} onRetry={() => void settings.refetch()} />;
  }
  const agent = settings.data?.agent;
  const webhookUrl = agent?.webhookUrl ?? "";
  const hasToken = (tokens.data ?? []).length > 0 || token !== null;

  return (
    <Card>
      <CardHeader
        icon={<Plug aria-hidden />}
        title="Connect Hermes"
        description="Hermes reads your memory over MCP and gets your voice commands over a signed webhook."
      />
      <CardBody className="flex flex-col gap-6">
        <Step n={1} title="Create an access token">
          <TokenStep created={token} onCreated={setToken} />
        </Step>

        <Step n={2} title="Webhook secret">
          {agent ? (
            <SecretStep
              isSet={agent.webhookSecretSet}
              hint={agent.webhookSecretHint}
              shown={secret}
              onChanged={setSecret}
            />
          ) : (
            <LoadingRows rows={1} />
          )}
        </Step>

        <Step n={3} title="Where does Hermes run?">
          {agent ? (
            <UrlStep
              stored={webhookUrl}
              saving={save.isPending}
              onSave={(url) => save.mutate({ agent: { webhookUrl: url } })}
            />
          ) : (
            <LoadingRows rows={1} />
          )}
        </Step>

        <Step n={4} title="Configure Hermes">
          {config.error ? (
            <ErrorNotice error={config.error} onRetry={() => void config.refetch()} />
          ) : config.data && agent ? (
            <ConfigStep
              token={token}
              secret={secret}
              hasSecret={agent.webhookSecretSet}
              mcpUrl={config.data.mcpUrl}
              webhookUrl={webhookUrl || hermesWebhookUrl({ kind: "local" })}
            />
          ) : (
            <LoadingRows rows={3} />
          )}
        </Step>

        <Step n={5} title="Check">
          <Checklist
            hasToken={hasToken}
            hasSecret={agent?.webhookSecretSet ?? false}
            hasUrl={webhookUrl !== ""}
          />
        </Step>

        <Harden />
      </CardBody>
    </Card>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-ink-2">
        {n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <h3 className="pt-0.5 text-[13px] font-semibold text-ink">{title}</h3>
        {children}
      </div>
    </section>
  );
}

function useCopy() {
  const toast = useToast();
  return (text: string) => {
    void navigator.clipboard.writeText(text);
    toast({ tone: "good", title: "Copied" });
  };
}

/** A value shown once, with a copy button. */
function ShownOnce({ label, value }: { label: string; value: string }) {
  const copy = useCopy();
  return (
    <div className="rounded-md border border-accent/40 bg-accent-soft p-3 text-[13px]">
      <p className="font-medium">{label}</p>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1 font-mono text-xs">
          {value}
        </code>
        <Button size="sm" onClick={() => copy(value)}>
          <Copy aria-hidden /> Copy
        </Button>
      </div>
    </div>
  );
}

function TokenStep({
  created,
  onCreated,
}: {
  created: string | null;
  onCreated: (token: string) => void;
}) {
  const tokens = useQuery(orpc.agent.tokens.list.queryOptions());
  const tz = useTimeZone() ?? "UTC";
  const now = useNow();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState("Hermes");
  const nameId = useId();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.agent.tokens.key() });
  const create = useMutation(
    orpc.agent.tokens.create.mutationOptions({
      onSuccess: (res) => {
        onCreated(res.token);
        refresh();
      },
      onError: (err) =>
        toast({ tone: "bad", title: "Couldn't create token", description: errorMessage(err) }),
    }),
  );
  const revoke = useMutation(orpc.agent.tokens.revoke.mutationOptions({ onSuccess: refresh }));

  return (
    <>
      <p className="text-xs text-ink-3">
        A token lets the agent search and read your timeline, and title, summarize, split, merge and
        re-classify episodes (never undoing your own edits). It can't delete anything.
      </p>
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
        <Button variant="primary" type="submit" loading={create.isPending} disabled={!name.trim()}>
          Create token
        </Button>
      </form>
      {created ? (
        <ShownOnce
          label="Copy this token now — it won't be shown again. It's also filled in below."
          value={created}
        />
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
    </>
  );
}

/**
 * The secret is write-only: the API says whether one is set (and its last characters), and returns
 * the full secret only when it generates one.
 */
function SecretStep({
  isSet,
  hint,
  shown,
  onChanged,
}: {
  isSet: boolean;
  hint: string | null;
  /** A secret generated in this visit (shown once), or null. */
  shown: string | null;
  onChanged: (generated: string | null) => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [own, setOwn] = useState("");
  const ownId = useId();
  const generate = useMutation(
    orpc.agent.generateWebhookSecret.mutationOptions({
      onSuccess: (res) => {
        queryClient.setQueryData(orpc.settings.get.queryKey(), res.settings);
        onChanged(res.secret);
      },
      onError: (err) =>
        toast({ tone: "bad", title: "Couldn't generate a secret", description: errorMessage(err) }),
    }),
  );
  const saveOwn = useMutation(
    orpc.settings.update.mutationOptions({
      onSuccess: (data) => {
        queryClient.setQueryData(orpc.settings.get.queryKey(), data);
        setOwn("");
        onChanged(null);
        toast({ tone: "good", title: "Secret saved" });
      },
      onError: (err) =>
        toast({ tone: "bad", title: "Couldn't save", description: errorMessage(err) }),
    }),
  );
  const ownValid = isValidWebhookSecret(own);

  return (
    <>
      <p className="text-xs text-ink-3">
        Hearloom signs every webhook with it (Standard Webhooks); Hermes's route checks it.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        {!isSet ? (
          <Button
            variant="primary"
            loading={generate.isPending}
            onClick={() => generate.mutate({})}
          >
            Generate secret
          </Button>
        ) : (
          <>
            <span className="inline-flex items-center gap-1.5 text-[13px] text-ink-2">
              <Check aria-hidden className="size-3.5 text-good" /> A secret is saved
              {hint ? (
                <>
                  {" "}
                  (ending in <code className="font-mono text-xs">{hint}</code>)
                </>
              ) : null}
              .
            </span>
            <ConfirmButton
              title="Regenerate the webhook secret?"
              description="Hermes rejects every voice command until you put the new secret in its config.yaml and restart the gateway."
              confirmLabel="Regenerate"
              variant="secondary"
              onConfirm={() => generate.mutateAsync({})}
            >
              <RefreshCw aria-hidden /> Regenerate
            </ConfirmButton>
          </>
        )}
      </div>
      {shown ? (
        <ShownOnce
          label="Copy this secret now — it won't be shown again. It's also filled in below."
          value={shown}
        />
      ) : null}
      <details className="text-[13px]">
        <summary className="cursor-pointer text-xs text-ink-3 select-none">
          Use my own secret
        </summary>
        <form
          className="mt-2 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            saveOwn.mutate({ agent: { webhookSecret: own } });
          }}
        >
          <Field
            label={isSet ? "New secret" : "Secret"}
            htmlFor={ownId}
            error={own && !ownValid ? "A whsec_ secret must be followed by base64." : undefined}
            hint="Replaces the saved one; it's never shown again. A whsec_ secret is a base64 key; anything else is used as raw bytes."
            className="w-96"
          >
            <Input
              id={ownId}
              value={own}
              type="password"
              autoComplete="new-password"
              aria-invalid={own !== "" && !ownValid}
              onChange={(e) => setOwn(e.target.value)}
            />
          </Field>
          <Button type="submit" loading={saveOwn.isPending} disabled={!own || !ownValid}>
            Save
          </Button>
        </form>
      </details>
    </>
  );
}

const WHERE: { kind: HermesWhere["kind"]; label: string }[] = [
  { kind: "local", label: "This machine" },
  { kind: "host", label: "Another host" },
  { kind: "custom", label: "Full URL" },
];

function UrlStep({
  stored,
  saving,
  onSave,
}: {
  stored: string;
  saving: boolean;
  onSave: (url: string) => void;
}) {
  const initial = parseHermesWebhookUrl(stored);
  const [kind, setKind] = useState(initial.kind);
  const [host, setHost] = useState(initial.kind === "host" ? initial.host : "");
  const [custom, setCustom] = useState(stored);
  const hostId = useId();
  const urlId = useId();
  useEffect(() => {
    const w = parseHermesWebhookUrl(stored);
    setKind(w.kind);
    if (w.kind === "host") setHost(w.host);
    setCustom(stored);
  }, [stored]);

  const hostOk = kind !== "host" || normalizeHost(host) !== null;
  const url =
    kind === "local"
      ? hermesWebhookUrl({ kind: "local" })
      : kind === "host"
        ? hostOk
          ? hermesWebhookUrl({ kind: "host", host })
          : ""
        : custom.trim();

  return (
    <>
      <p className="text-xs text-ink-3">
        Hearloom's server sends the webhook, so “this machine” means the machine the Hearloom server
        runs on. Hermes listens on port 8644.
      </p>
      <fieldset
        aria-label="Where Hermes runs"
        className="m-0 inline-flex w-fit rounded-md border border-line bg-surface-2 p-0.5"
      >
        {WHERE.map((w) => (
          <button
            key={w.kind}
            type="button"
            aria-pressed={kind === w.kind}
            onClick={() => {
              if (w.kind === "custom" && kind !== "custom" && url) setCustom(url);
              setKind(w.kind);
            }}
            className={cn(
              "h-7 cursor-pointer rounded px-3 text-xs font-medium text-ink-2",
              kind === w.kind && "bg-surface text-ink shadow-sm",
            )}
          >
            {w.label}
          </button>
        ))}
      </fieldset>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(url);
        }}
      >
        {kind === "host" ? (
          <Field
            label="Host"
            htmlFor={hostId}
            className="w-80"
            error={
              host.trim() && !hostOk
                ? "Expected a host name or IP, e.g. mac-mini.tail1234.ts.net"
                : undefined
            }
            hint="Its name on your tailnet or LAN, optionally with :port."
          >
            <Input
              id={hostId}
              value={host}
              placeholder="mac-mini.tail1234.ts.net"
              aria-invalid={host.trim() !== "" && !hostOk}
              onChange={(e) => setHost(e.target.value)}
            />
          </Field>
        ) : kind === "custom" ? (
          <Field label="Webhook URL" htmlFor={urlId} className="min-w-80 flex-1">
            <Input
              id={urlId}
              value={custom}
              placeholder={hermesWebhookUrl({ kind: "local" })}
              onChange={(e) => setCustom(e.target.value)}
            />
          </Field>
        ) : null}
        <Button variant="primary" type="submit" loading={saving} disabled={!url || url === stored}>
          {url === stored ? "Saved" : "Save"}
        </Button>
      </form>
      {kind !== "custom" && url ? (
        <p className="text-xs text-ink-3">
          Webhook URL: <code className="font-mono text-ink-2">{url}</code>
        </p>
      ) : null}
    </>
  );
}

function ConfigStep({
  token,
  secret,
  hasSecret,
  mcpUrl,
  webhookUrl,
}: {
  token: string | null;
  secret: string | null;
  hasSecret: boolean;
  mcpUrl: string;
  webhookUrl: string;
}) {
  return (
    <>
      <CopyBlock
        title="1. Add to ~/.hermes/.env"
        text={hermesEnvSnippet({ token })}
        note={
          token
            ? undefined
            : "The token is only filled in right after you create it. Paste yours, or create a new one in step 1."
        }
      />
      <CopyBlock
        title="2. Add to ~/.hermes/config.yaml"
        text={hermesConfigSnippet({ mcpUrl, webhookUrl, secret })}
        note={
          secret
            ? undefined
            : hasSecret
              ? "The secret is only filled in right after you generate it. Paste the one you saved, or regenerate it in step 2."
              : "Generate a secret in step 2 first."
        }
      />
      <CopyBlock
        title="3. Install the Hearloom skill and restart Hermes"
        text={hermesCommandsSnippet()}
      />
    </>
  );
}

function CopyBlock({ title, text, note }: { title: string; text: string; note?: string }) {
  const copy = useCopy();
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <h4 className="flex-1 text-xs font-medium text-ink-2">{title}</h4>
        <Button size="sm" variant="ghost" onClick={() => copy(text)}>
          <Copy aria-hidden /> Copy
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-md bg-surface-2 p-3 font-mono text-xs leading-relaxed">
        {text}
      </pre>
      {note ? <p className="text-xs text-warn-ink">{note}</p> : null}
    </div>
  );
}

function Checklist({
  hasToken,
  hasSecret,
  hasUrl,
}: {
  hasToken: boolean;
  hasSecret: boolean;
  hasUrl: boolean;
}) {
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
            description: `Hermes accepted it (HTTP ${r.httpStatus}). Its reply should arrive on Telegram.`,
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
  const items: { label: string; done?: boolean }[] = [
    { label: "An access token exists", done: hasToken },
    { label: "A webhook secret is saved", done: hasSecret },
    { label: "The webhook URL is saved", done: hasUrl },
    { label: "~/.hermes/.env and ~/.hermes/config.yaml updated with the blocks above" },
    { label: "The hearloom skill installed, and the gateway restarted" },
  ];
  return (
    <>
      <ul className="flex flex-col gap-1.5 text-[13px]">
        {items.map((item) => (
          <li key={item.label} className="flex items-center gap-2">
            {item.done === undefined ? (
              <Circle aria-hidden className="size-3.5 shrink-0 text-ink-3" />
            ) : item.done ? (
              <Check aria-label="done" className="size-3.5 shrink-0 text-good" />
            ) : (
              <Circle aria-label="not done" className="size-3.5 shrink-0 text-warn" />
            )}
            <span className={cn(item.done === false && "text-ink-2")}>{item.label}</span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          onClick={() => test.mutate({})}
          loading={test.isPending}
          disabled={!hasUrl}
          title={hasUrl ? undefined : "Save the webhook URL first"}
        >
          <Send aria-hidden /> Send test command
        </Button>
        <p className="text-xs text-ink-3">
          Hermes should reply on Telegram. Then teach your voice on the{" "}
          <Link to="/voice" className="text-accent-ink underline">
            Voice page
          </Link>
          .
        </p>
      </div>
    </>
  );
}

function Harden() {
  return (
    <div className="flex gap-3 rounded-md border border-warn/35 bg-warn-soft p-3 text-[13px] text-warn-ink">
      <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="flex flex-col gap-1">
        <p className="font-medium">Harden Hermes</p>
        <p>
          Transcripts are untrusted: anyone near the pendant (or a TV) can be heard. Keep Hermes's
          approvals on, and keep the terminal and browser toolsets out of the voice route — and
          ideally out of the Telegram chat too: with <code>mirror_to_session</code>, a “yes, do it”
          reply runs in that chat's session, with its tools. Run Hermes isolated (Docker or a
          separate macOS user).
        </p>
        <a
          href={AGENT_SECURITY_DOCS}
          target="_blank"
          rel="noreferrer"
          className={buttonClass("ghost", "sm", "w-fit px-0 text-warn-ink underline")}
        >
          docs/agent.md → Security <ExternalLink aria-hidden />
        </a>
      </div>
    </div>
  );
}
