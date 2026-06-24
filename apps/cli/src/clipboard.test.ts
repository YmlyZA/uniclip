import { expect, it, vi } from "vitest";
import { copyToClipboard } from "./clipboard";

it("writes via the injected writer and returns true", async () => {
  const writer = vi.fn(async () => {});
  expect(await copyToClipboard("hello", writer)).toBe(true);
  expect(writer).toHaveBeenCalledWith("hello");
});
it("returns false (no throw) when the writer fails", async () => {
  const writer = vi.fn(async () => { throw new Error("no clipboard"); });
  expect(await copyToClipboard("hello", writer)).toBe(false);
});
