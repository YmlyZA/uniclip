import { test, expect, chromium } from "@playwright/test";

test("deleting an item removes it on the other device", async () => {
  const browser = await chromium.launch();
  const ctxA = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const ctxB = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await pageA.goto("/");
  await pageA.getByRole("button", { name: /Zero-knowledge/i }).click();
  await pageA.getByRole("button", { name: /Create encrypted room/i }).click();
  await expect(pageA).toHaveURL(/\/r\/[a-z2-9]{6}#/);
  const roomUrl = pageA.url();
  await pageB.goto(roomUrl);
  await expect(pageA.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });
  await expect(pageB.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });

  // A sends a clip via the composer; both see it.
  await pageA.getByRole("textbox").fill("delete me");
  await pageA.getByRole("button", { name: /^Send$/i }).click();
  await expect(pageA.getByText("delete me")).toBeVisible({ timeout: 5_000 });
  await expect(pageB.getByText("delete me")).toBeVisible({ timeout: 5_000 });

  // A deletes it → it disappears on B too.
  await pageA.getByRole("button", { name: /Delete item/i }).first().click();
  await expect(pageA.getByText("delete me")).toHaveCount(0, { timeout: 5_000 });
  await expect(pageB.getByText("delete me")).toHaveCount(0, { timeout: 5_000 });

  await browser.close();
});
