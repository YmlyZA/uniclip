import { expect, it } from "vitest";
import { asciiQr } from "./qr";

it("renders a non-empty UTF-8 QR block for a URL", async () => {
  const out = await asciiQr("https://uniclip.app/r/abc123#sekretsekretsekret");
  expect(out.length).toBeGreaterThan(0);
  expect(out).toMatch(/[█▀▄ ]/); // contains block/half-block glyphs
});
