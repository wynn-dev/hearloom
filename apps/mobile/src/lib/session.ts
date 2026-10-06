import type { Contract } from "@hearloom/api";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import * as SecureStore from "expo-secure-store";

const KEYS = {
  server: "hearloom.server",
  token: "hearloom.token",
  phone: "hearloom.phone",
  email: "hearloom.email",
} as const;

export interface Session {
  serverURL: string;
  token: string;
  email: string;
  phoneId: string | null;
}

export function normalizeServerURL(input: string): string {
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url.replace(/\/+$/, "");
}

export async function loadSession(): Promise<Session | null> {
  const [serverURL, token, email, phoneId] = await Promise.all([
    SecureStore.getItemAsync(KEYS.server),
    SecureStore.getItemAsync(KEYS.token),
    SecureStore.getItemAsync(KEYS.email),
    SecureStore.getItemAsync(KEYS.phone),
  ]);
  if (!serverURL || !token) return null;
  return { serverURL, token, email: email ?? "", phoneId };
}

export async function saveSession(s: Session): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(KEYS.server, s.serverURL),
    SecureStore.setItemAsync(KEYS.token, s.token),
    SecureStore.setItemAsync(KEYS.email, s.email),
    s.phoneId ? SecureStore.setItemAsync(KEYS.phone, s.phoneId) : Promise.resolve(),
  ]);
}

/** Forget the session but keep the phone id, so signing in again reuses this phone's record. */
export async function clearSession(): Promise<void> {
  await Promise.all([SecureStore.deleteItemAsync(KEYS.token)]);
}

export async function storedPhoneId(): Promise<string | null> {
  return SecureStore.getItemAsync(KEYS.phone);
}

export async function storedServerURL(): Promise<string | null> {
  return SecureStore.getItemAsync(KEYS.server);
}

/** Email/password sign-in; returns the bearer session token. */
export async function signIn(serverURL: string, email: string, password: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${serverURL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: serverURL },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    throw new Error(`Can't reach ${serverURL}. Is the server running and Tailscale connected?`);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `Sign-in failed (${res.status})`);
  }
  const token = res.headers.get("set-auth-token");
  if (!token)
    throw new Error("Server did not return a session token (is the bearer plugin enabled?)");
  return token;
}

export async function signOutRemote(serverURL: string, token: string): Promise<void> {
  await fetch(`${serverURL}/api/auth/sign-out`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, origin: serverURL },
  }).catch(() => {});
}

export type Rpc = ContractRouterClient<Contract>;

export function createRpc(serverURL: string, token: string, onUnauthorized: () => void) {
  const client: Rpc = createORPCClient(
    new RPCLink({
      url: `${serverURL}/rpc`,
      headers: () => ({ authorization: `Bearer ${token}` }),
      fetch: async (request, init) => {
        const res = await fetch(request, init);
        if (res.status === 401) onUnauthorized();
        return res;
      },
    }),
  );
  return { client, orpc: createTanstackQueryUtils(client) };
}
