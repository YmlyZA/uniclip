import QRCode from "qrcode";

// A compact UTF-8 QR suitable for a terminal; `small` uses half-block glyphs.
export function asciiQr(text: string): Promise<string> {
  return QRCode.toString(text, { type: "terminal", small: true });
}
