import { test, expect, chromium } from "@playwright/test";

test("two browsers sync clipboard text in Mode A", async () => {
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
  // wait for connection on both (the status pill reads "Secure channel")
  await expect(pageA.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });
  await expect(pageB.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });

  // write into A's clipboard, click "Send clipboard now"
  await pageA.evaluate(() => navigator.clipboard.writeText("hello from A"));
  await pageA.getByRole("button", { name: /Send clipboard/i }).click();

  // assert it appears in B's list
  await expect(pageB.getByText("hello from A")).toBeVisible({ timeout: 5_000 });

  await browser.close();
});
