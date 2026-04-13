import { readFileSync } from "fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  outDir: "dist",
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: true,
  define: {
    __SDK_VERSION__: JSON.stringify(pkg.version),
  },
});
