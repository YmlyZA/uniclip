import { describe, expect, it } from "vitest";
import { imageNeedsPng } from "./image-copy";

describe("imageNeedsPng", () => {
  it("is false for png (already accepted by the async Clipboard write API)", () => {
    expect(imageNeedsPng("image/png")).toBe(false);
  });
  it("is true for jpeg/webp/others (Chrome's clipboard only writes png)", () => {
    expect(imageNeedsPng("image/jpeg")).toBe(true);
    expect(imageNeedsPng("image/webp")).toBe(true);
    expect(imageNeedsPng("image/gif")).toBe(true);
  });
});
