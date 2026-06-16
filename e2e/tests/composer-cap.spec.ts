import { test, expect, chromium } from "@playwright/test";

test("the composer blocks an over-size send", async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();

  await page.goto("/");
  await page.getByRole("button", { name: /Zero-knowledge/i }).click();
  await page.getByRole("button", { name: /Create encrypted room/i }).click();
  await expect(page).toHaveURL(/\/r\/[a-z2-9]{6}#/);

  // Fill with > 32 KiB of text.
  await page.getByRole("textbox").fill("x".repeat(33_000));

  await expect(page.getByRole("button", { name: /^Send$/i })).toBeDisabled();
  await expect(page.getByText(/32 KB/)).toBeVisible();

  await browser.close();
});
