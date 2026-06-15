import { test, expect, chromium } from "@playwright/test";

test("late joiner receives prior clips via Mode-A backfill", async () => {
  const browser = await chromium.launch();
  const ctxA = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const pageA = await ctxA.newPage();

  // A creates a Mode-A room with backfill left ON (the default).
  await pageA.goto("/");
  await pageA.getByRole("button", { name: /Zero-knowledge/i }).click();
  await pageA.getByRole("button", { name: /Create encrypted room/i }).click();
  await expect(pageA).toHaveURL(/\/r\/[a-z2-9]{6}#/);
  const roomUrl = pageA.url();

  await expect(pageA.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });
  // The relay echoes its per-room backfill flag in the hello frame; the room
  // shows this indicator only when backfill is enabled for the room.
  await expect(pageA.getByText(/recent items are shared/i)).toBeVisible({ timeout: 5_000 });

  // A sends two clips BEFORE any second device joins. These land only in the
  // relay's Mode-A backfill ring — there is no peer to fan them out to yet.
  await pageA.getByRole("textbox").fill("first clip");
  await pageA.getByRole("button", { name: /^Send$/i }).click();
  await expect(pageA.getByText("first clip")).toBeVisible({ timeout: 5_000 });

  await pageA.getByRole("textbox").fill("second clip");
  await pageA.getByRole("button", { name: /^Send$/i }).click();
  await expect(pageA.getByText("second clip")).toBeVisible({ timeout: 5_000 });

  // B joins the same room URL (with the #secret fragment) as a LATE joiner.
  // It never saw the live frames; the only way it can show them is the relay
  // replaying the backfill ring on join.
  const ctxB = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const pageB = await ctxB.newPage();
  await pageB.goto(roomUrl);
  await expect(pageB.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });

  // B must receive both prior items.
  await expect(pageB.getByText("first clip")).toBeVisible({ timeout: 5_000 });
  await expect(pageB.getByText("second clip")).toBeVisible({ timeout: 5_000 });

  // ...and in send order. The list renders newest-first, so "second clip"
  // appears above "first clip" in DOM order.
  const texts = await pageB.getByTestId("clip").allInnerTexts();
  const backfilled = texts.map((t) => t.trim()).filter((t) => t === "first clip" || t === "second clip");
  expect(backfilled).toEqual(["second clip", "first clip"]);

  await browser.close();
});
