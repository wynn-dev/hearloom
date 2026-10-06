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
  useState,
} from "react";
import { type PushState, registerCategories, registerForPush } from "./push";
import {
  clearSession,
  createRpc,
  loadSession,
  type Rpc,
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
  signOut(): Promise<void>;
  refreshPush(): Promise<void>;
}

const Ctx = createContext<SessionApi | null>(null);

async function registerPhone(rpc: Rpc): Promise<string> {
  const existing = await storedPhoneId();
  const { phoneId } = await rpc.phones.register({
    ...(existing ? { id: existing } : {}),
    name: Device.deviceName ?? "iPhone",
    model: Device.modelName ?? undefined,
    osVersion: Device.osVersion ?? undefined,
    appVersion: Application.nativeApplicationVersion ?? undefined,
    bundleId: Application.applicationId ?? undefined,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  return phoneId;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: "loading" });

  const signOutLocal = useCallback(async () => {
    await clearSession();
    OmiCapture.signOut();
    queryClient.clear();
    setState({ status: "signedOut" });
  }, []);

  const activate = useCallback(
    async (session: Session) => {
      const { client, orpc } = createRpc(session.serverURL, session.token, () => {
        void signOutLocal();
      });
      const phoneId = await registerPhone(client);
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
      const session = await loadSession();
      if (!session) return setState({ status: "signedOut" });
      try {
        await activate(session);
      } catch (err) {
        // Server unreachable: stay signed in locally; the native engine keeps buffering.
        console.warn("session restore failed", err);
        const { client, orpc } = createRpc(session.serverURL, session.token, () => {
          void signOutLocal();
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

  const api = useMemo<SessionApi>(
    () => ({
      state,
      async signIn(serverURL, email, password) {
        const token = await signIn(serverURL, email, password);
        await activate({ serverURL, token, email, phoneId: await storedPhoneId() });
      },
      async signOut() {
        if (state.status === "signedIn")
          await signOutRemote(state.session.serverURL, state.session.token);
        await signOutLocal();
      },
      async refreshPush() {
        if (state.status !== "signedIn") return;
        const push = await registerForPush(state.rpc, state.session.phoneId);
        setState((s) => (s.status === "signedIn" ? { ...s, push } : s));
      },
    }),
    [state, activate, signOutLocal],
  );

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
