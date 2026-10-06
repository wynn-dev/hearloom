import { useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import {
  Activity,
  Bell,
  CalendarDays,
  ChevronsUpDown,
  LogOut,
  Menu,
  SlidersHorizontal,
  Smartphone,
  Users,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { authClient } from "../lib/auth";
import { cn } from "../lib/cn";
import { useMe } from "../lib/me";
import { useRealtimeState } from "../lib/realtime";
import { Brand } from "./brand";
import { Badge } from "./ui/badge";
import { Dot } from "./ui/misc";

const NAV = [
  { to: "/", label: "Now", icon: Activity, exact: true },
  { to: "/timeline", label: "Timeline", icon: CalendarDays, exact: false },
  { to: "/notifications", label: "Notifications", icon: Bell, exact: false },
  { to: "/devices", label: "Devices", icon: Smartphone, exact: false },
  { to: "/settings", label: "Settings", icon: SlidersHorizontal, exact: false },
] as const;

const navLink =
  "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink data-[status=active]:bg-surface-3 data-[status=active]:text-ink [&_svg]:size-4 [&_svg]:text-ink-3 data-[status=active]:[&_svg]:text-accent";

function Nav({ isAdmin }: { isAdmin: boolean }) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {NAV.map(({ to, label, icon: Icon, exact }) => (
        <Link key={to} to={to} activeOptions={{ exact }} className={navLink}>
          <Icon aria-hidden />
          {label}
        </Link>
      ))}
      {isAdmin ? (
        <Link to="/users" className={navLink}>
          <Users aria-hidden />
          Users
        </Link>
      ) : null}
    </nav>
  );
}

function RealtimeIndicator() {
  const state = useRealtimeState();
  const label =
    state === "open" ? "Live updates" : state === "connecting" ? "Connecting…" : "Reconnecting…";
  return (
    <div className="flex items-center gap-2 px-2.5 text-xs text-ink-3" title="Realtime connection">
      <Dot tone={state === "open" ? "good" : "warn"} />
      {label}
    </div>
  );
}

function UserMenu() {
  const me = useMe();
  const session = authClient.useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const user = me.data?.user ?? session.data?.user;
  const name = user?.name || user?.email || "…";
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const signOut = async () => {
    setOpen(false);
    await authClient.signOut();
    // Wait until the session store is empty, or /login sees the old session and bounces back.
    await session.refetch();
    await navigate({ to: "/login" });
    // Clear only once the signed-in pages are unmounted, or their observers refetch (and 401).
    queryClient.clear();
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-md p-1.5 text-left hover:bg-surface-2"
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent-ink">
          {initials}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink">{name}</span>
          <span className="block truncate text-xs text-ink-3">{user?.email}</span>
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-ink-3" aria-hidden />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 bottom-full left-0 mb-1 rounded-lg border border-line bg-surface p-1 shadow-pop"
        >
          <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs text-ink-3">
            <span className="truncate">{user?.email}</span>
            {me.data?.user.role === "admin" ? <Badge tone="accent">admin</Badge> : null}
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={signOut}
            className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-ink hover:bg-surface-2"
          >
            <LogOut className="size-3.5 text-ink-3" aria-hidden />
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SidebarContent({ isAdmin }: { isAdmin: boolean }) {
  return (
    <>
      <div className="flex h-12 items-center px-2.5">
        <Link to="/" aria-label="Hearloom home">
          <Brand />
        </Link>
      </div>
      <div className="mt-2 flex-1 overflow-y-auto">
        <Nav isAdmin={isAdmin} />
      </div>
      <div className="flex flex-col gap-2 border-t border-line pt-3">
        <RealtimeIndicator />
        <UserMenu />
      </div>
    </>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const me = useMe();
  const isAdmin = me.data?.user.role === "admin";
  const pathname = useLocation({ select: (l) => l.pathname });
  const [drawer, setDrawer] = useState(false);

  // Close the mobile drawer whenever the route changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger
  useEffect(() => setDrawer(false), [pathname]);

  return (
    <div className="min-h-dvh lg:pl-56">
      <aside className="fixed inset-y-0 left-0 hidden w-56 flex-col border-r border-line bg-surface p-3 lg:flex">
        <SidebarContent isAdmin={isAdmin} />
      </aside>

      <header className="sticky top-0 z-30 flex h-12 items-center justify-between border-b border-line bg-surface/90 px-4 backdrop-blur lg:hidden">
        <Brand />
        <button
          type="button"
          aria-label="Open menu"
          onClick={() => setDrawer(true)}
          className="cursor-pointer rounded-md p-1.5 text-ink-2 hover:bg-surface-2"
        >
          <Menu className="size-5" aria-hidden />
        </button>
      </header>

      {drawer ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 cursor-default bg-black/30"
            onClick={() => setDrawer(false)}
          />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col border-r border-line bg-surface p-3 shadow-pop">
            <button
              type="button"
              aria-label="Close menu"
              onClick={() => setDrawer(false)}
              className="absolute top-3 right-3 cursor-pointer rounded-md p-1 text-ink-3 hover:bg-surface-2"
            >
              <X className="size-4" aria-hidden />
            </button>
            <SidebarContent isAdmin={isAdmin} />
          </aside>
        </div>
      ) : null}

      <main className={cn("mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8")}>{children}</main>
    </div>
  );
}
