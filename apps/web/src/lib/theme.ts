import { get, writable } from "svelte/store";

export type ThemePref = "light" | "dark" | "system";

const KEY = "uniclip:theme";

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {}
  return "system";
}

function systemDark(): boolean {
  return (
    typeof matchMedia !== "undefined" &&
    matchMedia("(prefers-color-scheme: dark)").matches
  );
}

/** The effective theme for a given preference. */
export function resolved(pref: ThemePref): "light" | "dark" {
  return pref === "system" ? (systemDark() ? "dark" : "light") : pref;
}

function apply(pref: ThemePref): void {
  if (typeof document === "undefined") return;
  const dark = resolved(pref) === "dark";
  document.documentElement.classList.toggle("dark", dark);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", dark ? "#0b0d11" : "#eef1f5");
}

export const theme = writable<ThemePref>(readPref());

theme.subscribe((pref) => {
  try {
    localStorage.setItem(KEY, pref);
  } catch {}
  apply(pref);
});

// Re-apply when the OS theme flips while we're following the system.
if (typeof matchMedia !== "undefined") {
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (get(theme) === "system") apply("system");
  });
}

/** Advance light → dark → system → light. */
export function cycleTheme(): void {
  theme.update((p) => (p === "light" ? "dark" : p === "dark" ? "system" : "light"));
}
