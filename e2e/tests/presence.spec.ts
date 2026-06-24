import { test, expect, chromium } from "@playwright/test";

test("two devices appear in each other's roster by name", async () => {
  const browser = await chromium.launch();
  const ctxA = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const ctxB = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  await a.goto("/");
  await a.getByRole("button", { name: /Zero-knowledge/i }).click();
  await a.getByRole("button", { name: /Create encrypted room/i }).click();
  await expect(a).toHaveURL(/\/r\/[a-z2-9]{6}#/);
  const url = a.url();
  await b.goto(url);

  await expect(a.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });
  await expect(b.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });

  // Open the roster on A, rename to "Laptop".
  await a.getByRole("button", { name: /Connected devices/i }).click();
  await a.getByRole("button", { name: /Rename this device/i }).click();
  await a.getByRole("textbox", { name: /Your device name/i }).fill("Laptop");
  await a.getByRole("textbox", { name: /Your device name/i }).press("Enter");

  // Rename B to "Phone".
  await b.getByRole("button", { name: /Connected devices/i }).click();
  await b.getByRole("button", { name: /Rename this device/i }).click();
  await b.getByRole("textbox", { name: /Your device name/i }).fill("Phone");
  await b.getByRole("textbox", { name: /Your device name/i }).press("Enter");

  // Re-open A's roster (it may have closed after renaming; ensure it is open for the assertion).
  const aRosterBtn = a.getByRole("button", { name: /Connected devices/i });
  const aRosterExpanded = await aRosterBtn.getAttribute("aria-expanded");
  if (aRosterExpanded !== "true") {
    await aRosterBtn.click();
  }

  // Each sees the other's name in the roster.
  await expect(b.getByText("Laptop")).toBeVisible({ timeout: 10_000 });
  await expect(a.getByText("Phone")).toBeVisible({ timeout: 10_000 });

  await browser.close();
});
