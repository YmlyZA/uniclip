import { MAX_FILE_BYTES, CHUNK_BYTES } from "@uniclip/protocol";

export { MAX_FILE_BYTES };

/** The cap as a whole number of MB, for user-facing messages. */
export const MAX_FILE_MB = Math.round(MAX_FILE_BYTES / (1024 * 1024));

export function tooLarge(file: { size: number }): boolean {
  return file.size > MAX_FILE_BYTES;
}

/** How many chunks the engine will split a file of this byte length into. */
export function chunkCountOf(byteLength: number): number {
  return Math.max(1, Math.ceil(byteLength / CHUNK_BYTES));
}

export async function readFileBytes(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}
