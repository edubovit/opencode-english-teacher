import solid from "@opentui/solid/bun-plugin"

const result = await Bun.build({
  entrypoints: ["./src/tui.tsx"],
  outdir: "./dist",
  naming: "[name].[ext]",
  target: "bun",
  format: "esm",
  packages: "external",
  plugins: [solid],
  sourcemap: "none",
  minify: false,
})
if (!result.success) throw new AggregateError(result.logs, "TUI build failed")
await Bun.write("./dist/tui.d.ts", 'export { default } from "../src/tui.tsx"\n')
console.log("Built dist/tui.js with external host runtimes.")
