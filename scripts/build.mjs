import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const platform = process.platform === "win32" ? "windows" : process.platform
const arch = process.arch === "arm64" ? "aarch64" : process.arch
const suffix = process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime ? "-musl" : ""
const executable = require.resolve(`@oven/bun-${platform}-${arch}${suffix}/bin/bun${process.platform === "win32" ? ".exe" : ""}`)
const child = spawn(executable, [fileURLToPath(new URL("./build-ui.mjs", import.meta.url))], {
  cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: "inherit",
})
child.on("error", error => { console.error(error); process.exitCode = 1 })
child.on("exit", code => { process.exitCode = code ?? 1 })
