import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Ban, Check, Copy, KeyRound, ShieldCheck, Trash2, UserPlus, Users } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader, PageHeader } from "../../components/ui/card";
import { ConfirmButton } from "../../components/ui/dialog";
import { Field, Input, Select } from "../../components/ui/input";
import { EmptyState, ErrorNotice, LoadingRows, Spinner } from "../../components/ui/misc";
import { useToast } from "../../components/ui/toast";
import { authClient } from "../../lib/auth";
import { useMe, useTimeZone } from "../../lib/me";
import { errorMessage } from "../../lib/orpc";
import { formatDate } from "../../lib/time";

export const Route = createFileRoute("/_app/users")({
  component: UsersPage,
});

const USERS_KEY = ["admin", "users"] as const;
const MIN_PASSWORD = 10;

/** Better Auth returns `{ data, error }`; turn errors into exceptions for TanStack Query. */
async function unwrap<T>(promise: Promise<{ data: T | null; error: unknown }>): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(errorMessage(error));
  return data as T;
}

function generatePassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint32Array(16));
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
  return chars.match(/.{4}/g)!.join("-");
}

function UsersPage() {
  const me = useMe();
  if (me.isPending) return <LoadingRows />;
  if (me.data?.user.role !== "admin") {
    return (
      <>
        <PageHeader title="Users" />
        <Card>
          <EmptyState icon={<ShieldCheck />} title="Admins only">
            Ask an administrator to manage accounts.
          </EmptyState>
        </Card>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="Users"
        description="Hearloom is invite-only: accounts are created here by an administrator."
      />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <UserList selfId={me.data.user.id} />
        <CreateUser />
      </div>
    </>
  );
}

function UserList({ selfId }: { selfId: string }) {
  const tz = useTimeZone() ?? "UTC";
  const queryClient = useQueryClient();
  const toast = useToast();
  const users = useQuery({
    queryKey: USERS_KEY,
    queryFn: () =>
      unwrap(
        authClient.admin.listUsers({
          query: { limit: 200, sortBy: "createdAt", sortDirection: "asc" },
        }),
      ),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: USERS_KEY });
  const act = useMutation({
    mutationFn: (fn: () => Promise<{ data: unknown; error: unknown }>) => unwrap(fn()),
    onSuccess: () => void refresh(),
    onError: (error) =>
      toast({ tone: "bad", title: "Action failed", description: errorMessage(error) }),
  });

  return (
    <Card>
      <CardHeader
        icon={<Users aria-hidden />}
        title="Accounts"
        description={users.data ? `${users.data.total} total` : undefined}
        actions={act.isPending ? <Spinner className="text-ink-3" /> : null}
      />
      {users.error ? (
        <ErrorNotice error={users.error} onRetry={() => void users.refetch()} className="m-4" />
      ) : null}
      {users.isPending ? (
        <LoadingRows />
      ) : users.data?.users.length === 0 ? (
        <EmptyState title="No users" />
      ) : users.data ? (
        <ul className="divide-y divide-line">
          {users.data.users.map((u) => {
            const self = u.id === selfId;
            const isAdmin = u.role === "admin";
            return (
              <li key={u.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1 basis-56">
                  <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
                    <span className="truncate">{u.name || u.email}</span>
                    {isAdmin ? <Badge tone="accent">admin</Badge> : <Badge>user</Badge>}
                    {u.banned ? (
                      <Badge tone="bad" title={u.banReason ?? undefined}>
                        banned
                      </Badge>
                    ) : null}
                    {self ? <span className="text-xs font-normal text-ink-3">(you)</span> : null}
                  </p>
                  <p className="truncate text-xs text-ink-3">
                    {u.email} · joined {formatDate(new Date(u.createdAt), tz)}
                  </p>
                </div>
                {self ? null : (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        act.mutate(() =>
                          authClient.admin.setRole({
                            userId: u.id,
                            role: isAdmin ? "user" : "admin",
                          }),
                        )
                      }
                    >
                      <ShieldCheck aria-hidden />
                      {isAdmin ? "Make user" : "Make admin"}
                    </Button>
                    {u.banned ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          act.mutate(() => authClient.admin.unbanUser({ userId: u.id }))
                        }
                      >
                        <Check aria-hidden />
                        Unban
                      </Button>
                    ) : (
                      <ConfirmButton
                        variant="ghost"
                        title={`Ban ${u.email}?`}
                        description="They are signed out everywhere and can't sign in until unbanned. Their data is kept."
                        confirmLabel="Ban"
                        onConfirm={() =>
                          act.mutateAsync(() => authClient.admin.banUser({ userId: u.id }))
                        }
                      >
                        <Ban aria-hidden />
                        Ban
                      </ConfirmButton>
                    )}
                    <ConfirmButton
                      title={`Delete ${u.email}?`}
                      description="This permanently deletes the account and its sessions. This cannot be undone."
                      confirmLabel="Delete user"
                      onConfirm={() =>
                        act.mutateAsync(() => authClient.admin.removeUser({ userId: u.id }))
                      }
                    >
                      <Trash2 aria-hidden />
                      Delete
                    </ConfirmButton>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </Card>
  );
}

function CreateUser() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [generated, setGenerated] = useState(false);
  const [role, setRole] = useState<"user" | "admin">("user");
  const [created, setCreated] = useState<{ email: string; password: string | null } | null>(null);
  const [copied, setCopied] = useState(false);

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        authClient.admin.createUser({ name: name.trim(), email: email.trim(), password, role }),
      ),
    onSuccess: () => {
      setCreated({ email: email.trim(), password: generated ? password : null });
      setName("");
      setEmail("");
      setPassword("");
      setGenerated(false);
      setRole("user");
      setCopied(false);
      void queryClient.invalidateQueries({ queryKey: USERS_KEY });
      toast({ tone: "good", title: "User created" });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD;

  return (
    <Card className="lg:sticky lg:top-6">
      <CardHeader icon={<UserPlus aria-hidden />} title="Create user" />
      <CardBody className="flex flex-col gap-3">
        {created ? (
          <div className="rounded-lg border border-good/30 bg-good-soft p-3 text-[13px]">
            <p className="font-medium text-good-ink">Account created for {created.email}</p>
            {created.password ? (
              <>
                <p className="mt-1 text-xs text-ink-2">
                  Share this password now — it won't be shown again.
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-md border border-line bg-surface px-2 py-1 font-mono text-[13px] select-all">
                    {created.password}
                  </code>
                  <Button
                    size="sm"
                    onClick={() => {
                      void navigator.clipboard.writeText(created.password ?? "").then(() => {
                        setCopied(true);
                      });
                    }}
                  >
                    {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </div>
              </>
            ) : null}
            <button
              type="button"
              onClick={() => setCreated(null)}
              className="mt-2 cursor-pointer text-xs text-ink-3 underline underline-offset-2"
            >
              Dismiss
            </button>
          </div>
        ) : null}
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Field label="Name" htmlFor="new-name">
            <Input
              id="new-name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
            />
          </Field>
          <Field label="Email" htmlFor="new-email">
            <Input
              id="new-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="off"
            />
          </Field>
          <Field
            label="Password"
            htmlFor="new-password"
            error={tooShort ? `At least ${MIN_PASSWORD} characters` : undefined}
            hint="Generate one and share it with them securely."
          >
            <div className="flex gap-2">
              <Input
                id="new-password"
                type={generated ? "text" : "password"}
                required
                minLength={MIN_PASSWORD}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setGenerated(false);
                }}
                aria-invalid={tooShort || undefined}
                autoComplete="new-password"
                className="font-mono"
              />
              <Button
                onClick={() => {
                  setPassword(generatePassword());
                  setGenerated(true);
                }}
              >
                <KeyRound aria-hidden />
                Generate
              </Button>
            </div>
          </Field>
          <Field label="Role" htmlFor="new-role">
            <Select
              id="new-role"
              value={role}
              onChange={(e) => setRole(e.target.value === "admin" ? "admin" : "user")}
            >
              <option value="user">User</option>
              <option value="admin">Admin — can manage users</option>
            </Select>
          </Field>
          {create.error ? <ErrorNotice error={create.error} /> : null}
          <Button
            type="submit"
            variant="primary"
            loading={create.isPending}
            disabled={tooShort}
            className="justify-center"
          >
            <UserPlus aria-hidden />
            Create user
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
