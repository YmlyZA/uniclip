import { test, expect, chromium } from "@playwright/test";

// Minimal 1×1 transparent PNG.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

test("inline image is received automatically; a larger file uses offer→accept→download", async () => {
  const browser = await chromium.launch();
  const ctxA = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const pageA = await ctxA.newPage();
  await pageA.goto("/");
  await pageA.getByRole("button", { name: /Zero-knowledge/i }).click();
  await pageA.getByRole("button", { name: /Create encrypted room/i }).click();
  await expect(pageA).toHaveURL(/\/r\/[a-z2-9]{6}#/);
  const roomUrl = pageA.url();
  await expect(pageA.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });

  const ctxB = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const pageB = await ctxB.newPage();
  await pageB.goto(roomUrl);
  await expect(pageB.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });

  // A sends a small PNG → inline image, auto-accepted on B → thumbnail + download.
  // Two composers (desktop rail + mobile bar) each render a file input; target the first.
  await pageA.locator('input[type="file"]').first().setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: PNG_1x1 });
  await expect(pageB.getByTestId("transfer-thumb")).toBeVisible({ timeout: 10_000 });
  await expect(pageB.getByTestId("transfer-download")).toBeVisible({ timeout: 10_000 });

  // A sends a ~300 KB non-image → B sees an offer card → Accept → Download appears.
  const big = Buffer.alloc(300 * 1024, 7);
  await pageA.locator('input[type="file"]').first().setInputFiles({ name: "blob.bin", mimeType: "application/octet-stream", buffer: big });
  await expect(pageB.getByRole("button", { name: /^Accept$/ })).toBeVisible({ timeout: 10_000 });
  await pageB.getByRole("button", { name: /^Accept$/ }).click();
  await expect(pageB.getByTestId("transfer-download").last()).toBeVisible({ timeout: 15_000 });

  await browser.close();
});
