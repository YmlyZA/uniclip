export const KDF_ITERATIONS = 200_000;
export const KEY_BITS = 256;

export interface DeriveKeyOptions {
  /** The user-provided secret (URL fragment for Mode A, typed CODE for Mode B). */
  secret: string;
  /** Salt: routingId for Mode A, "uniclip-v1" for Mode B. */
  salt: string;
}

const encoder = new TextEncoder();

export async function deriveKey(opts: DeriveKeyOptions): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(opts.secret),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode(opts.salt),
      iterations: KDF_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: KEY_BITS },
    true, // extractable so tests can compare raw bytes; production code never exports
    ["encrypt", "decrypt"],
  );
}
