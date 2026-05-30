export const IV_BYTES = 12;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface EncryptInput {
  key: CryptoKey;
  plaintext: string;
  /** Associated data — bound into the GCM auth tag. */
  aad: string;
}

export interface Envelope {
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
}

export async function encrypt(input: EncryptInput): Promise<Envelope> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encoder.encode(input.aad),
    },
    input.key,
    encoder.encode(input.plaintext),
  );
  return { iv: iv.buffer, ciphertext };
}

export interface DecryptInput {
  key: CryptoKey;
  iv: BufferSource;
  ciphertext: BufferSource;
  aad: string;
}

export async function decrypt(input: DecryptInput): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: input.iv,
      additionalData: encoder.encode(input.aad),
    },
    input.key,
    input.ciphertext,
  );
  return decoder.decode(plain);
}

/** Helpers to round-trip envelopes through JSON (base64). */
export function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]!);
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
