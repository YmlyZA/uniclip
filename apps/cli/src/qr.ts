import QRCode from "qrcode";

// Pure Unicode block glyphs — no ANSI escape codes, layout-safe inside Ink.
export function asciiQr(text: string): Promise<string> {
  return QRCode.toString(text, { type: "utf8" });
}
