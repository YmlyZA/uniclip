import { afterEach, expect, it, vi } from "vitest";
import { defaultDeviceName } from "./device-name";

afterEach(() => vi.unstubAllGlobals());

it("derives a Browser · OS label from a Chrome/macOS UA", () => {
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36" });
  expect(defaultDeviceName()).toBe("Chrome · macOS");
});

it("derives Safari · iPhone from an iOS Safari UA", () => {
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" });
  expect(defaultDeviceName()).toBe("Safari · iPhone");
});

it("falls back to 'This device' when the UA is unrecognized", () => {
  vi.stubGlobal("navigator", { userAgent: "something-weird" });
  expect(defaultDeviceName()).toBe("This device");
});
