import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  dts: { resolve: true },
  noExternal: ["@tescord/types"],
  sourcemap: true,
  clean: true,
  treeshake: true,
});
