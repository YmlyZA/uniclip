export const MODE_A_ROUTING_ID_LEN = 6;
export const MODE_A_SECRET_LEN = 18;

// Lowercase alphanumerics minus 0/1 (look-alikes for o/l)
export const MODE_A_ROUTING_ALPHABET = "abcdefghijklmnopqrstuvwxyz23456789";
// URL-safe base64 alphabet (RFC 4648 §5)
export const MODE_A_SECRET_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export interface ModeARoom {
  mode: "A";
  routingId: string;
  secret: string;
}

export interface ModeBRoom {
  mode: "B";
  routingId: string;
}

export type ParsedRoom = ModeARoom | ModeBRoom;

function randomFrom(alphabet: string, len: number): string {
  const out = new Array<string>(len);
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  for (let i = 0; i < len; i++) {
    // Modulo bias is negligible at these alphabet sizes for 8-bit input
    out[i] = alphabet[bytes[i]! % alphabet.length]!;
  }
  return out.join("");
}

export function generateModeARoom(): { routingId: string; secret: string } {
  return {
    routingId: randomFrom(MODE_A_ROUTING_ALPHABET, MODE_A_ROUTING_ID_LEN),
    secret: randomFrom(MODE_A_SECRET_ALPHABET, MODE_A_SECRET_LEN),
  };
}

export function parseRoomUrl(input: string): ParsedRoom | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const match = /^\/r\/([^/?#]+)$/.exec(url.pathname);
  if (!match) return null;
  const routingId = match[1]!;
  if (!routingId) return null;
  const secret = url.hash.startsWith("#") ? url.hash.slice(1) : "";
  if (secret) {
    return { mode: "A", routingId, secret };
  }
  return { mode: "B", routingId };
}
