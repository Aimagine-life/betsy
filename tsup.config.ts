import { defineConfig } from "tsup";
import { cpSync, mkdirSync, existsSync } from "node:fs";

export default defineConfig({
  entry: ["src/index.ts", "src/multi/sim/dialogue-sim.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  external: ["playwright", "pg-boss"],
  clean: false,
  splitting: false,
  sourcemap: true,
  dts: false,
  banner: { js: "#!/usr/bin/env node" },
  onSuccess: async () => {
    const src = "src/multi/db/migrations";
    if (existsSync(src)) {
      const dest1 = "dist/multi/db/migrations";
      const dest2 = "dist/migrations";
      mkdirSync(dest1, { recursive: true });
      mkdirSync(dest2, { recursive: true });
      cpSync(src, dest1, { recursive: true });
      cpSync(src, dest2, { recursive: true });
      console.log("[tsup] copied migrations to dist");
    }
  },
});
