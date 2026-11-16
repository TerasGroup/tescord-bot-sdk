import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/index.ts", "src/setup.ts", "src/secret-contract-api.ts"],
  format: ["esm"],
  target: "node24",
  dts: { resolve: true },
  noExternal: ["@nekord/bot-sdk", "@tescord/types"],
  external: [/^openclaw\/plugin-sdk(?:\/.*)?$/],
  sourcemap: true,
  clean: true,
  treeshake: true,
});
