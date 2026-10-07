import { type ClientHttp2Session, connect } from "node:http2";
import { importPKCS8, SignJWT } from "jose";

export type ApnsEnv = "sandbox" | "production";

export interface ApnsConfig {
  keyPem: string;
  keyId: string;
  teamId: string;
  bundleId: string;
}

export interface ApnsNotification {
  id: string;
  title: string;
  body: string;
  /** Notification category registered by the app (apps/mobile/src/lib/push.ts). */
  category: "HL_SYSTEM";
  deepLink?: string | null;
  interruptionLevel: "passive" | "active" | "time-sensitive";
  collapseKey?: string | null;
}

export interface ApnsResult {
  ok: boolean;
  status: number;
  apnsId?: string;
  reason?: string;
  /** The token is dead (uninstalled app / revoked): stop using it. */
  unregistered: boolean;
}

const HOSTS: Record<ApnsEnv, string> = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};

/** APNs payloads are capped at 4 KB; keep generous headroom. */
const MAX_BODY_CHARS = 1500;

export function buildApnsPayload(n: ApnsNotification): Record<string, unknown> {
  const body = n.body.length > MAX_BODY_CHARS ? `${n.body.slice(0, MAX_BODY_CHARS - 1)}…` : n.body;
  return {
    aps: {
      alert: { title: n.title, body },
      ...(n.interruptionLevel === "passive" ? {} : { sound: "default" }),
      "thread-id": n.category,
      category: n.category,
      "interruption-level": n.interruptionLevel,
    },
    // expo-notifications exposes the `body` object as `content.data` in JS.
    body: { hlId: n.id, ...(n.deepLink ? { deepLink: n.deepLink } : {}) },
  };
}

/** Token-based (.p8) APNs client over HTTP/2. One session per environment, reused. */
export class ApnsClient {
  private jwt: { token: string; issuedAt: number } | null = null;
  private key: CryptoKey | null = null;
  private sessions = new Map<ApnsEnv, ClientHttp2Session>();

  constructor(private readonly cfg: ApnsConfig) {}

  private async bearer(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    // Apple: refresh no more than every 20 min and at least every 60 min.
    if (this.jwt && now - this.jwt.issuedAt < 40 * 60) return this.jwt.token;
    this.key ??= await importPKCS8(this.cfg.keyPem, "ES256");
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: this.cfg.keyId })
      .setIssuer(this.cfg.teamId)
      .setIssuedAt(now)
      .sign(this.key);
    this.jwt = { token, issuedAt: now };
    return token;
  }

  private session(env: ApnsEnv): ClientHttp2Session {
    const existing = this.sessions.get(env);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const s = connect(HOSTS[env]);
    const drop = () => {
      if (this.sessions.get(env) === s) this.sessions.delete(env);
    };
    s.on("error", drop);
    s.on("goaway", drop);
    s.on("close", drop);
    this.sessions.set(env, s);
    return s;
  }

  async send(deviceToken: string, env: ApnsEnv, n: ApnsNotification): Promise<ApnsResult> {
    const jwt = await this.bearer();
    const payload = JSON.stringify(buildApnsPayload(n));
    const headers: Record<string, string> = {
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      authorization: `bearer ${jwt}`,
      "apns-topic": this.cfg.bundleId,
      "apns-push-type": "alert",
      // Always immediate: priority 5 lets iOS batch alerts for power, and a late notification is a stale one.
      "apns-priority": "10",
      "apns-id": n.id,
      "content-type": "application/json",
    };
    if (n.collapseKey) headers["apns-collapse-id"] = n.collapseKey.slice(0, 64);

    return new Promise<ApnsResult>((resolve) => {
      let req: ReturnType<ClientHttp2Session["request"]>;
      try {
        req = this.session(env).request(headers);
      } catch (err) {
        resolve({ ok: false, status: 0, reason: String(err), unregistered: false });
        return;
      }
      let status = 0;
      let apnsId: string | undefined;
      let data = "";
      req.setEncoding("utf8");
      req.setTimeout(10_000, () => req.close());
      req.on("response", (h) => {
        status = Number(h[":status"] ?? 0);
        apnsId = h["apns-id"] as string | undefined;
      });
      req.on("data", (chunk: string) => {
        data += chunk;
      });
      req.on("end", () => {
        let reason: string | undefined;
        if (data) {
          try {
            reason = (JSON.parse(data) as { reason?: string }).reason;
          } catch {
            reason = data;
          }
        }
        resolve({
          ok: status === 200,
          status,
          apnsId,
          reason,
          // BadDeviceToken usually means a sandbox/production mismatch, not a dead token.
          unregistered: status === 410,
        });
      });
      req.on("error", (err) =>
        resolve({ ok: false, status, reason: String(err), unregistered: false }),
      );
      req.end(payload);
    });
  }

  close(): void {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }
}
