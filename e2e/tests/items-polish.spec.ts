import { test, expect, chromium } from "@playwright/test";

test("smart clips: link renders, pin marks, search filters", async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();

  await page.goto("/");
  await page.getByRole("button", { name: /Zero-knowledge/i }).click();
  await page.getByRole("button", { name: /Create encrypted room/i }).click();
  await expect(page).toHaveURL(/\/r\/[a-z2-9]{6}#/);
  await expect(page.getByText(/secure channel/i)).toBeVisible({ timeout: 10_000 });

  // Send a clip containing a URL.
  await page.getByRole("textbox").first().fill("visit https://example.com/page now");
  await page.getByRole("button", { name: /^Send$/i }).click();

  // The URL renders as a real link.
  const link = page.getByRole("link", { name: "https://example.com/page" });
  await expect(link).toBeVisible({ timeout: 10_000 });
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);

  // Pin it → pin button becomes Unpin.
  const pin = page.getByRole("button", { name: /^Pin item$/i }).first();
  await pin.click();
  await expect(page.getByRole("button", { name: /^Unpin item$/i }).first()).toBeVisible({ timeout: 5_000 });

  // Send a second, non-matching clip, then search.
  await page.getByRole("textbox").first().fill("totally different text");
  await page.getByRole("button", { name: /^Send$/i }).click();
  await expect(page.getByText("totally different text")).toBeVisible({ timeout: 5_000 });

  await page.getByRole("searchbox", { name: /Search items/i }).fill("example");
  await expect(page.getByText("totally different text")).toHaveCount(0);
  await expect(link).toBeVisible();

  await browser.close();
});
