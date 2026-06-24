import { expect, it } from "vitest";
import { asciiQr } from "./qr";

it("renders a non-empty UTF-8 QR block for a URL", async () => {
  const out = await asciiQr("https://uniclip.app/r/abc123#sekretsekretsekret");
  expect(out.length).toBeGreaterThan(0);
  expect(out).toMatch(/[█▀▄ ]/); // contains block/half-block glyphs
  // Must contain no ANSI escape codes — layout-safe in Ink.
  // eslint-disable-next-line no-control-regex
  expect(out).not.toMatch(/\x1b\[/);
});
