// A user-chosen Mode-B code. In Mode B the code IS the encryption key material
// (see client-core deriveRoomKey), so canonicalization MUST be byte-identical on
// client and relay or peers derive different keys. Frozen + unit-tested.
export const CUSTOM_CODE_MIN = 4;
export const CUSTOM_CODE_MAX = 64;
const CUSTOM_CODE_RE = /^[A-Z0-9-]+$/;

export function canonicalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export function isValidCustomCode(raw: string): boolean {
  const c = canonicalizeCode(raw);
  if (c.length < CUSTOM_CODE_MIN || c.length > CUSTOM_CODE_MAX) return false;
  if (!CUSTOM_CODE_RE.test(c)) return false;
  if (/^-+$/.test(c)) return false; // not solely hyphens
  return true;
}

// Rough entropy estimate (bits) from length × log2(effective charset), with a
// penalty for low character variety (e.g. "AAAA"). Not a security guarantee —
// it drives the strength meter that nudges users toward stronger codes.
export function estimateCodeBits(canonical: string): number {
  if (!canonical) return 0;
  let charset = 0;
  if (/[A-Z]/.test(canonical)) charset += 26;
  if (/[0-9]/.test(canonical)) charset += 10;
  if (/-/.test(canonical)) charset += 1;
  const perChar = Math.log2(Math.max(charset, 2));
  const variety = new Set(canonical).size / canonical.length; // (0,1]
  return Math.round(canonical.length * perChar * (0.4 + 0.6 * variety));
}

export type StrengthBand = "very-weak" | "weak" | "ok";
export function strengthBand(bits: number): StrengthBand {
  if (bits < 28) return "very-weak";
  if (bits < 48) return "weak";
  return "ok";
}
