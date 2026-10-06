import { createRootRoute, Link, Outlet } from "@tanstack/react-router";

export const Route = createRootRoute({
  component: Outlet,
  notFoundComponent: NotFound,
});

function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 text-center">
      <p className="text-lg font-semibold">Page not found</p>
      <Link to="/" className="text-[13px] text-accent-ink underline underline-offset-2">
        Back to Now
      </Link>
    </div>
  );
}
