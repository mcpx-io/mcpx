import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["server.ts"],
  format: ["esm"],
  outDir: "dist",
  splitting: false,
  external: ["googleapis", "google-auth-library"],
  banner: { js: "#!/usr/bin/env node" },
});
