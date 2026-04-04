import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["server.ts"],
  format: ["cjs"],
  outDir: "dist",
  splitting: false,
  platform: "node",
  noExternal: ["@modelcontextprotocol/sdk", "zod"],
  banner: { js: "#!/usr/bin/env node" },
  outExtension: () => ({ js: ".js" }),
});
