import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["server.ts", "setup-oauth.ts"],
  format: ["cjs"],
  outDir: "dist",
  splitting: false,
  platform: "node",
  noExternal: ["googleapis", "google-auth-library"],
  banner: { js: "#!/usr/bin/env node" },
  outExtension: () => ({ js: ".js" }),
});
