import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const platform = process.platform === "win32" ? "windows" : process.platform
const arch = process.arch === "arm64" ? "aarch64" : process.arch
const suffix = process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime ? "-musl" : ""
let executable
try {
  executable = require.resolve(`@oven/bun-${platform}-${arch}${suffix}/bin/bun${process.platform === "win32" ? ".exe" : ""}`)
} catch {
  console.error("Bundled Bun is missing. Install development and optional dependencies before running test:tui.")
  process.exit(1)
}
const cwd = fileURLToPath(new URL("../", import.meta.url))
const tests = readdirSync(new URL("../tests/", import.meta.url)).filter(name => /^tui.*\.tsx$/.test(name)).map(name => `./tests/${name}`)
const child = spawn(executable, ["test", "--conditions=browser", "--preload", "@opentui/solid/preload", ...tests], { cwd, stdio: "inherit" })
child.on("error", error => { console.error(error); process.exitCode = 1 })
child.on("exit", code => { process.exitCode = code ?? 1 })
