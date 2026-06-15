import { test, expect, chromium } from "@playwright/test";

// A Mode-A room opened WITHOUT its #secret (e.g. a link whose fragment got
// stripped) connects to the same room but derives a Mode-B key, so frames
// arrive yet never decrypt. The app must surface this, not fail silently.
test("joining a Mode-A room without the secret shows a decrypt warning", async () => {
  const browser = await chromium.launch();
  const ctxA = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const pageA = await ctxA.newPage();

  await pageA.goto("/");
  await pageA.getByRole("button", { name: /Zero-knowledge/i }).click();
  await pageA.getByRole("button", { name: /Create encrypted room/i }).click();
  await expect(pageA).toHaveURL(/\/r\/[a-z2-9]{6}#/);
  const full = pageA.url();

  // A sends a clip so the relay's backfill ring has something to replay.
  await expect(pageA.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });
  await pageA.getByRole("textbox").fill("locked content");
  await pageA.getByRole("button", { name: /^Send$/i }).click();
  await expect(pageA.getByText("locked content")).toBeVisible({ timeout: 5_000 });

  // B opens the SAME room without the #secret → Mode B → wrong key.
  const ctxB = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const pageB = await ctxB.newPage();
  await pageB.goto(full.split("#")[0]);

  await expect(pageB.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });
  await expect(pageB.getByText(/can't decrypt this room/i)).toBeVisible({ timeout: 5_000 });
  await expect(pageB.getByText("locked content")).toHaveCount(0);

  await browser.close();
});
