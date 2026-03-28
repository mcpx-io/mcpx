import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["server.ts"],
  format: ["esm"],
  outDir: "dist",
  splitting: false,
  external: ["ssh2"],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
