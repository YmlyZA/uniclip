import { createHmac } from "node:crypto";

// coturn `use-auth-secret` REST scheme: username is the unix expiry, password is
// base64(HMAC-SHA1(static-auth-secret, username)). coturn validates the HMAC with
// no shared per-user state. Creds attach only to turn:/turns: entries.
export interface TurnConfig {
  urls: string[];
  secret: string;
  ttlSeconds: number;
}

export interface RTCIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export function mintIceCredentials(cfg: TurnConfig, now: number): { iceServers: RTCIceServer[] } {
  const expiry = Math.floor(now / 1000) + cfg.ttlSeconds;
  const username = String(expiry);
  const credential = createHmac("sha1", cfg.secret).update(username).digest("base64");
  const iceServers: RTCIceServer[] = cfg.urls.map((urls) =>
    urls.startsWith("turn:") || urls.startsWith("turns:")
      ? { urls, username, credential }
      : { urls },
  );
  return { iceServers };
}
