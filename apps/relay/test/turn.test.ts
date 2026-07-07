import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { mintIceCredentials } from "../src/turn";

const cfg = {
  urls: ["stun:turn.example.com:3478", "turn:turn.example.com:3478", "turns:turn.example.com:5349"],
  secret: "s3cr3t",
  ttlSeconds: 3600,
};

describe("mintIceCredentials", () => {
  it("mints an expiry username and HMAC-SHA1 credential", () => {
    const now = 1_000_000_000_000; // ms
    const { iceServers } = mintIceCredentials(cfg, now);
    const expiry = String(1_000_000_000 + 3600);
    const cred = createHmac("sha1", "s3cr3t").update(expiry).digest("base64");
    const turn = iceServers.find((s) => String(s.urls).startsWith("turn:"))!;
    expect(turn.username).toBe(expiry);
    expect(turn.credential).toBe(cred);
  });

  it("attaches creds to turn:/turns: entries only, not stun:", () => {
    const { iceServers } = mintIceCredentials(cfg, 1_000_000_000_000);
    const stun = iceServers.find((s) => String(s.urls).startsWith("stun:"))!;
    const turns = iceServers.find((s) => String(s.urls).startsWith("turns:"))!;
    expect(stun.username).toBeUndefined();
    expect(stun.credential).toBeUndefined();
    expect(turns.username).toBeDefined();
    expect(turns.credential).toBeDefined();
  });
});
