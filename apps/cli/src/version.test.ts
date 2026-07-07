import { describe, expect, it } from "vitest";
import { fmtVersion } from "./version";

describe("fmtVersion", () => {
  it("appends the sha unless it is 'dev'", () => {
    expect(fmtVersion("0.1.0", "a730078")).toBe("0.1.0 (a730078)");
    expect(fmtVersion("0.1.0", "dev")).toBe("0.1.0");
    expect(fmtVersion("dev", "dev")).toBe("dev");
  });
});
