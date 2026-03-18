import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  external: ["playwright"],
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: false,
  banner: { js: "#!/usr/bin/env node" },
});
