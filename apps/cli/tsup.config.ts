import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.tsx"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  banner: { js: "#!/usr/bin/env node" },
  clean: true,
  // Bundle the workspace TS deps; keep heavy native/ESM deps external.
  noExternal: [/@uniclip\//],
});
