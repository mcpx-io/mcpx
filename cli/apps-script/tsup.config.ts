import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["server.ts"],
  format: ["esm"],
  outDir: "dist",
  splitting: false,
  external: ["googleapis"],
  banner: { js: "#!/usr/bin/env node" },
});
