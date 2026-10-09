import type { Contract } from "@hearloom/api";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import * as SecureStore from "expo-secure-store";

// Readable after the first unlock, so a background relaunch (Bluetooth state restoration) can load the
// session while the phone is locked.
const STORE_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

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
    SecureStore.getItemAsync(KEYS.server, STORE_OPTS),
    SecureStore.getItemAsync(KEYS.token, STORE_OPTS),
    SecureStore.getItemAsync(KEYS.email, STORE_OPTS),
    SecureStore.getItemAsync(KEYS.phone, STORE_OPTS),
  ]);
  if (!serverURL || !token) return null;
  return { serverURL, token, email: email ?? "", phoneId };
}

export async function saveSession(s: Session): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(KEYS.server, s.serverURL, STORE_OPTS),
    SecureStore.setItemAsync(KEYS.token, s.token, STORE_OPTS),
    SecureStore.setItemAsync(KEYS.email, s.email, STORE_OPTS),
    s.phoneId ? SecureStore.setItemAsync(KEYS.phone, s.phoneId, STORE_OPTS) : Promise.resolve(),
  ]);
}

/** Forget the session but keep the phone id, so signing in again reuses this phone's record. */
export async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(KEYS.token, STORE_OPTS);
}

export async function storedPhoneId(): Promise<string | null> {
  return SecureStore.getItemAsync(KEYS.phone, STORE_OPTS);
}

export async function storedServerURL(): Promise<string | null> {
  return SecureStore.getItemAsync(KEYS.server, STORE_OPTS);
}

/** POST JSON to one of the server's auth endpoints. */
async function postAuth(serverURL: string, path: string, body: unknown): Promise<Response> {
  try {
    return await fetch(`${serverURL}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: serverURL },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`Can't reach ${serverURL}. Is the server running and Tailscale connected?`);
  }
}

function sessionToken(res: Response): string {
  const token = res.headers.get("set-auth-token");
  if (!token)
    throw new Error("Server did not return a session token (is the bearer plugin enabled?)");
  return token;
}

/**
 * "Link device" sign-in with a single-use code from the console (Devices → Link a device) or
 * `pnpm link-device`; returns the bearer session token and the account it signs in to.
 */
export async function redeemLinkCode(
  serverURL: string,
  code: string,
): Promise<{ token: string; email: string }> {
  const res = await postAuth(serverURL, "/link/redeem", { code });
  const body = (await res.json().catch(() => null)) as {
    message?: string;
    user?: { email?: string };
  } | null;
  if (res.status === 404)
    throw new Error(
      `${serverURL} can't link devices: check the server address, or update the server.`,
    );
  if (!res.ok) throw new Error(body?.message ?? `Linking failed (${res.status})`);
  return { token: sessionToken(res), email: body?.user?.email ?? "" };
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
