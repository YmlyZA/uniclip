// A-Z minus O and I, plus 2-9 (0 and 1 already excluded)
export const MODE_B_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const MODE_B_CODE_LEN = 6;
export const MODE_B_SALT = "uniclip-v1";

export function generateModeBCode(): string {
  const out = new Array<string>(MODE_B_CODE_LEN);
  const bytes = crypto.getRandomValues(new Uint8Array(MODE_B_CODE_LEN));
  for (let i = 0; i < MODE_B_CODE_LEN; i++) {
    out[i] = MODE_B_ALPHABET[bytes[i]! % MODE_B_ALPHABET.length]!;
  }
  return out.join("");
}

const RE = new RegExp(`^[${MODE_B_ALPHABET}]{${MODE_B_CODE_LEN}}$`);

export function isValidModeBCode(s: string): boolean {
  return RE.test(s);
}
