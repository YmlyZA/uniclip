import { test, expect, chromium } from "@playwright/test";

// A peer that was offline (page closed) when another peer deleted an item must
// remove it on rejoin, via the relay's tombstone replay. The deleter stays
// connected, so the room never empties and the tombstone survives.
test("an offline peer removes a deleted item on rejoin", async () => {
  const browser = await chromium.launch();
  const ctxA = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const ctxB = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const pageA = await ctxA.newPage();
  let pageB = await ctxB.newPage();

  await pageA.goto("/");
  await pageA.getByRole("button", { name: /Zero-knowledge/i }).click();
  await pageA.getByRole("button", { name: /Create encrypted room/i }).click();
  await expect(pageA).toHaveURL(/\/r\/[a-z2-9]{6}#/);
  const roomUrl = pageA.url();

  await pageB.goto(roomUrl);
  await expect(pageA.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });
  await expect(pageB.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });

  // A sends; B receives and persists it.
  await pageA.getByRole("textbox").fill("ephemeral");
  await pageA.getByRole("button", { name: /^Send$/i }).click();
  await expect(pageB.getByText("ephemeral")).toBeVisible({ timeout: 5_000 });

  // B goes offline — close the page but KEEP the context (localStorage persists).
  await pageB.close();

  // A deletes while B is offline.
  await pageA.getByRole("button", { name: /Delete item/i }).first().click();
  await expect(pageA.getByText("ephemeral")).toHaveCount(0, { timeout: 5_000 });

  // B reopens in the SAME context (same localStorage, still has the item) →
  // the relay replays the tombstone on join → B removes it.
  pageB = await ctxB.newPage();
  await pageB.goto(roomUrl);
  await expect(pageB.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });
  await expect(pageB.getByText("ephemeral")).toHaveCount(0, { timeout: 5_000 });

  await browser.close();
});
