// Plaintext send cap. Bounded by the protocol's 64 KiB frame limit
// (MAX_FRAME_BYTES): ciphertext is base64 (~1.33x) plus JSON overhead, so a
// frame stays under 64 KiB for plaintext up to ~40 KiB. 32 KiB leaves margin.
// Larger content is future file-transfer territory.
export const MAX_TEXT_BYTES = 32 * 1024;

export function textByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function withinLimit(text: string): boolean {
  return textByteLength(text) <= MAX_TEXT_BYTES;
}
