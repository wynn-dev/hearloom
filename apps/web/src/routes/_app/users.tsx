import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Ban, Check, Link2, ShieldCheck, Trash2, UserPlus, Users } from "lucide-react";
import { type FormEvent, useState } from "react";
import { LinkDeviceDialog } from "../../components/link-device";
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

/** Better Auth returns `{ data, error }`; turn errors into exceptions for TanStack Query. */
async function unwrap<T>(promise: Promise<{ data: T | null; error: unknown }>): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(errorMessage(error));
  return data as T;
}

/** Whose device the admin is linking (a new account, or one from the list). */
interface LinkTarget {
  userId: string;
  label: string;
}

function UsersPage() {
  const me = useMe();
  const [linking, setLinking] = useState<LinkTarget | null>(null);
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
        <UserList selfId={me.data.user.id} onLink={setLinking} />
        <CreateUser onCreated={setLinking} />
      </div>
      <LinkDeviceDialog
        open={linking !== null}
        onClose={() => setLinking(null)}
        userId={linking?.userId}
        title={linking ? `Link a device for ${linking.label}` : "Link a device"}
      />
    </>
  );
}

function UserList({ selfId, onLink }: { selfId: string; onLink: (target: LinkTarget) => void }) {
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
                      disabled={Boolean(u.banned)}
                      title={u.banned ? "Unban them first" : "Sign one of their devices in"}
                      onClick={() => onLink({ userId: u.id, label: u.name || u.email })}
                    >
                      <Link2 aria-hidden />
                      Link a device
                    </Button>
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

/**
 * New accounts have no password: they sign in by linking a device. Creating one opens the link
 * dialog for it, so the admin can show them the QR code (or send the link) right away.
 */
function CreateUser({ onCreated }: { onCreated: (target: LinkTarget) => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");

  const create = useMutation({
    mutationFn: () =>
      unwrap(authClient.admin.createUser({ name: name.trim(), email: email.trim(), role })),
    onSuccess: ({ user }) => {
      setName("");
      setEmail("");
      setRole("user");
      void queryClient.invalidateQueries({ queryKey: USERS_KEY });
      toast({ tone: "good", title: "User created" });
      onCreated({ userId: user.id, label: user.name || user.email });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <Card className="lg:sticky lg:top-6">
      <CardHeader icon={<UserPlus aria-hidden />} title="Create user" />
      <CardBody>
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
          <p className="text-xs text-ink-3">
            No password needed: next you get a QR code and link that sign their first device in.
          </p>
          {create.error ? <ErrorNotice error={create.error} /> : null}
          <Button
            type="submit"
            variant="primary"
            loading={create.isPending}
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
