import type { Contract } from "@hearloom/api";
import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";

const link = new RPCLink({ url: `${location.origin}/rpc` });

/** Typed RPC client. Same-origin, so the Better Auth session cookie authenticates every call. */
export const client: ContractRouterClient<Contract> = createORPCClient(link);

/** TanStack Query helpers: `orpc.status.live.queryOptions()`, `orpc.timeline.key()`, ... */
export const orpc = createTanstackQueryUtils(client);

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ORPCError && (error.code === "UNAUTHORIZED" || error.status === 401);
}

/** A short, human message for any error thrown by the RPC client or Better Auth. */
export function errorMessage(error: unknown): string {
  if (error instanceof ORPCError) return error.message || error.code;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return "Something went wrong";
}
