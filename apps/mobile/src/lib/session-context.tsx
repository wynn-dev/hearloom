import { ORPCError } from "@orpc/client";
import { QueryClient } from "@tanstack/react-query";
import * as Application from "expo-application";
import * as Device from "expo-device";
import { OmiCapture } from "omi-capture";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type PushState, registerCategories, registerForPush } from "./push";
import {
  clearSession,
  createRpc,
  loadSession,
  type Rpc,
  redeemLinkCode,
  type Session,
  saveSession,
  signIn,
  signOutRemote,
  storedPhoneId,
} from "./session";

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, retry: 1 } },
});

type SessionState =
  | { status: "loading" }
  | { status: "signedOut" }
  | {
      status: "signedIn";
      session: Session & { phoneId: string };
      rpc: Rpc;
      orpc: ReturnType<typeof createRpc>["orpc"];
      push: PushState | "pending";
    };

interface SessionApi {
  state: SessionState;
  signIn(serverURL: string, email: string, password: string): Promise<void>;
  /** Sign in with a "Link device" code; if already signed in, that session ends once the code works. */
  linkDevice(serverURL: string, code: string): Promise<void>;
  signOut(): Promise<void>;
  refreshPush(): Promise<void>;
}

const Ctx = createContext<SessionApi | null>(null);

async function registerPhone(rpc: Rpc): Promise<string> {
  const existing = await storedPhoneId();
  const info = {
    name: Device.deviceName ?? "iPhone",
    model: Device.modelName ?? undefined,
    osVersion: Device.osVersion ?? undefined,
    appVersion: Application.nativeApplicationVersion ?? undefined,
    bundleId: Application.applicationId ?? undefined,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  try {
    const { phoneId } = await rpc.phones.register({
      ...(existing ? { id: existing } : {}),
      ...info,
    });
    return phoneId;
  } catch (err) {
    // The stored id belongs to another account (signed in with someone else before): get a new one.
    if (!existing || !(err instanceof ORPCError && err.code === "CONFLICT")) throw err;
    const { phoneId } = await rpc.phones.register(info);
    return phoneId;
  }
}

async function loadSessionSafe(): Promise<Session | null> {
  try {
    return await loadSession();
  } catch (err) {
    console.warn("couldn't read the stored session", err);
    return null;
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: "loading" });

  // The token in use. A request still in flight with a token that was replaced (signed in again with a
  // link code) may come back 401; that must not sign out the new one.
  const currentToken = useRef<string | null>(null);

  const signOutLocal = useCallback(async () => {
    currentToken.current = null;
    await clearSession();
    OmiCapture.signOut();
    queryClient.clear();
    setState({ status: "signedOut" });
  }, []);

  const activate = useCallback(
    async (session: Session) => {
      currentToken.current = session.token;
      const { client, orpc } = createRpc(session.serverURL, session.token, () => {
        if (currentToken.current === session.token) void signOutLocal();
      });
      const phoneId = await registerPhone(client);
      // Replaced meanwhile (linked again while this was in flight): don't store the old token.
      if (currentToken.current !== session.token) return;
      const full = { ...session, phoneId };
      await saveSession(full);
      // Hand the server + token to the native engine so capture keeps working without JS.
      OmiCapture.configure(full.serverURL, full.token, phoneId);
      setState({ status: "signedIn", session: full, rpc: client, orpc, push: "pending" });
      await registerCategories();
      const push = await registerForPush(client, phoneId);
      setState((s) => (s.status === "signedIn" ? { ...s, push } : s));
    },
    [signOutLocal],
  );

  useEffect(() => {
    void (async () => {
      const session = await loadSessionSafe();
      if (!session) return setState({ status: "signedOut" });
      try {
        await activate(session);
      } catch (err) {
        // Server unreachable: stay signed in locally; the native engine keeps buffering.
        console.warn("session restore failed", err);
        const { client, orpc } = createRpc(session.serverURL, session.token, () => {
          if (currentToken.current === session.token) void signOutLocal();
        });
        if (session.phoneId) {
          OmiCapture.configure(session.serverURL, session.token, session.phoneId);
          setState({
            status: "signedIn",
            session: { ...session, phoneId: session.phoneId },
            rpc: client,
            orpc,
            push: "pending",
          });
        } else {
          setState({ status: "signedOut" });
        }
      }
    })();
  }, [activate, signOutLocal]);

  // The server doesn't know this phone (removed in the web console, or its id now belongs to another
  // account): register it again, which hands the (new) id to the native engine.
  const lastReRegister = useRef(0);
  const signedInSession = state.status === "signedIn" ? state.session : null;
  useEffect(() => {
    if (!signedInSession) return;
    const sub = OmiCapture.addListener("onStatus", (s) => {
      if (s.serverErrorCode !== "unknown_phone" || Date.now() - lastReRegister.current < 60_000)
        return;
      lastReRegister.current = Date.now();
      void activate(signedInSession).catch((err) =>
        console.warn("re-registering the phone failed", err),
      );
    });
    return () => sub.remove();
  }, [signedInSession, activate]);

  const api = useMemo<SessionApi>(() => {
    const signOut = async () => {
      if (state.status === "signedIn") {
        // End this phone's open streams and stop pushes before the token is revoked.
        await state.rpc.phones
          .signOut({ id: state.session.phoneId })
          .catch((err) => console.warn("phones.signOut failed", err));
        await signOutRemote(state.session.serverURL, state.session.token);
      }
      await signOutLocal();
    };
    return {
      state,
      async signIn(serverURL, email, password) {
        const token = await signIn(serverURL, email, password);
        await activate({ serverURL, token, email, phoneId: await storedPhoneId() });
      },
      async linkDevice(serverURL, code) {
        const { token, email } = await redeemLinkCode(serverURL, code);
        // Redeem first: a wrong or expired code leaves the current session alone.
        if (state.status === "signedIn") await signOut();
        await activate({ serverURL, token, email, phoneId: await storedPhoneId() });
      },
      signOut,
      async refreshPush() {
        if (state.status !== "signedIn") return;
        const push = await registerForPush(state.rpc, state.session.phoneId);
        setState((s) => (s.status === "signedIn" ? { ...s, push } : s));
      },
    };
  }, [state, activate, signOutLocal]);

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useSession(): SessionApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSession outside SessionProvider");
  return ctx;
}

/** For screens that only render when signed in. */
export function useSignedIn() {
  const { state } = useSession();
  if (state.status !== "signedIn") throw new Error("not signed in");
  return state;
}
