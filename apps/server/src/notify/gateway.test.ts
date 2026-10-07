import { describe, expect, test } from "bun:test";
import { deliverToPhone } from "./gateway";

/** Channels that record which ones were used. */
function channels(opts: {
  push?: boolean | null;
  socket?: "acked" | "unacked" | "failed" | null;
  buzz?: boolean;
}) {
  const used: string[] = [];
  return {
    used,
    channels: {
      push:
        opts.push == null
          ? null
          : async () => {
              used.push("push");
              return opts.push === true;
            },
      socket:
        opts.socket == null
          ? null
          : async () => {
              used.push("socket");
              return opts.socket!;
            },
      buzz: opts.buzz ? () => void used.push("buzz") : null,
    },
  };
}

describe("delivery to one phone", () => {
  test("push first; the socket only buzzes, so the phone shows one banner", async () => {
    const c = channels({ push: true, socket: "acked", buzz: true });
    expect(await deliverToPhone(c.channels)).toBe("apns");
    expect(c.used).toEqual(["push", "buzz"]);
  });

  test("falls back to the socket when push fails or isn't set up", async () => {
    const failed = channels({ push: false, socket: "acked", buzz: true });
    expect(await deliverToPhone(failed.channels)).toBe("acked");
    expect(failed.used).toEqual(["push", "socket"]);

    const none = channels({ socket: "unacked" });
    expect(await deliverToPhone(none.channels)).toBe("socket");
    expect(none.used).toEqual(["socket"]);
  });

  test("fails when no channel gets it out", async () => {
    expect(await deliverToPhone(channels({ push: false, socket: "failed" }).channels)).toBe(
      "failed",
    );
    expect(await deliverToPhone(channels({}).channels)).toBe("failed");
  });
});
