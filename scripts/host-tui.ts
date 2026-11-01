import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { spawn } from "@lydell/node-pty"
import headless from "@xterm/headless"
import { providerID, type HostFixture } from "./host-fixture.ts"
import type { Correction } from "../src/contracts.ts"

export async function verifyTui(test: HostFixture, sessionID: string) {
  const corrections: Correction[] = ["First", "Second", "Third", "Fourth", "Fifth"].map(ordinal => ({
    original: `${ordinal} synthetic phrase gives advices about the café example and explains how the team can check a deliberately long sentence without relying on any earlier conversation or attached files.`,
    replacement: `${ordinal} synthetic phrase gives advice about the café example and explains how the team can check a deliberately long sentence without relying on any earlier conversation or attached files.`,
    explanation: `${ordinal} scrolling explanation. Advice is uncountable. This synthetic comment checks wrapping and independent vertical scrolling inside the installed terminal interface.`,
  }))
  const marker = `The scrolling elm example. ${corrections.map(item => item.original).join(" ")}`
  const before = (await test.rpc.status({ sessionID }, test.rpcOptions)).count
  test.reply(marker, corrections)
  await test.client.session.prompt({ sessionID, text: marker })
  await test.client.session.wait({ sessionID })
  await test.until(async () => (await test.rpc.status({ sessionID }, test.rpcOptions)).count === before + 1, "long TUI correction fixture")
  const clean = "The latest clear ash example is already correct."
  const cleanCalls = test.teachers().length
  test.reply(clean, [])
  await test.client.session.prompt({ sessionID, text: clean })
  await test.client.session.wait({ sessionID })
  await test.until(() => test.teachers().length === cleanCalls + 1, "latest clean TUI analysis")
  await test.until(async () => (await test.rpc.status({ sessionID }, test.rpcOptions)).pending === 0, "latest clean TUI input")
  const cliConfig = join(test.root, "config", "opencode", "cli.json")
  const theme = async (mode: "dark" | "light") => writeFile(cliConfig, JSON.stringify({ theme: { mode }, animations: false, tabs: { mode: "off" } }))
  await theme("dark")
  const screen = new headless.Terminal({ cols: 100, rows: 30, allowProposedApi: true, scrollback: 0 })
  const child = spawn(test.executable, ["--server", test.url, "--session", sessionID, test.workspace], {
    cols: 100, rows: 30, cwd: test.workspace, env: test.env, name: "xterm-256color",
  })
  let raw = ""
  let ended = false
  let pending = Promise.resolve()
  const exited = new Promise<number>(done => child.onExit(event => { ended = true; done(event.exitCode) }))
  screen.onData(data => { if (!ended) child.write(data) })
  child.onData(data => {
    raw = (raw + data).slice(-4_000_000)
    pending = pending.then(() => new Promise<void>(done => screen.write(data, done)))
  })
  const text = async () => {
    await pending
    const buffer = screen.buffer.active
    return Array.from({ length: screen.rows }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true, 0, screen.cols) ?? "").join("\n")
  }
  const colors = async () => {
    await pending
    const buffer = screen.buffer.active
    return JSON.stringify(Array.from({ length: screen.rows }, (_, row) => {
      const line = buffer.getLine(buffer.viewportY + row)
      return Array.from({ length: screen.cols }, (_, column) => {
        const cell = line?.getCell(column)
        return [cell?.getFgColor(), cell?.getBgColor()]
      })
    }))
  }
  const keys = async (value: string) => {
    assert.ok(!ended, "Owned TUI exited before input")
    child.write(value)
    await test.quiet(100)
  }
  const seen = (value: string) => test.until(async () => (await text()).includes(value), `installed TUI: ${value}`)
  const snapshot = async (name: string) => test.save(`tui-${name}.txt`, await text())
  const resize = async (cols: number, rows: number) => {
    screen.resize(cols, rows)
    child.resize(cols, rows)
    await test.quiet(250)
  }
  let calls = test.requests.length
  const history = await test.client.session.context({ sessionID })
  const inbox = await test.client.session.inbox.list({ sessionID })
  let completed = false
  try {
    await seen("The latest clear ash example is already correct.")
    await keys("/english")
    await test.until(async () => /\/english\s+English teacher/.test(await text()), "slash-command discovery before Return")
    await keys("\r")
    await seen("English teacher")
    await seen("Analysis on")
    await seen("1/3 newest first")
    await seen("scrolling elm")
    await seen('1. "First synthetic phrase')
    await snapshot("slash-latest")
    const notificationSession = await test.client.session.create({
      title: "Notify fixture", location: { directory: test.workspace }, model: { providerID, id: "source" },
    })
    const notificationMarker = "The notification alder example gives advices."
    test.reply(notificationMarker, [{ original: "gives advices", replacement: "gives advice", explanation: "TOAST_CONTENT_SENTINEL." }])
    await test.client.session.prompt({ sessionID: notificationSession.id, text: notificationMarker })
    await test.client.session.wait({ sessionID: notificationSession.id })
    await seen("Notify fixture")
    await seen("New comment saved.")
    assert.ok((await text()).includes("1/3 newest first"), "Cross-session notification changed the teacher selection or focus")
    assert.ok(!(await text()).includes("TOAST_CONTENT_SENTINEL"), "Notification exposed a correction body")
    await snapshot("cross-session-toast")
    await test.until(async () => !(await text()).includes("New comment saved."), "correction toast expires without navigation")
    assert.equal(test.requests.length, calls + 2, "Unexpected requests in cross-session notification fixture")
    calls = test.requests.length
    await keys("\x1b[5~")
    await seen("2/3 newest first")
    await seen("queued maple")
    await keys("\x1b[5~")
    await seen("3/3 newest first")
    await seen("coding hold")
    await keys("\x1b[5~")
    assert.ok((await text()).includes("3/3 newest first"), "Page Up wrapped at the oldest comment")
    await keys("\x1b[6~")
    await seen("2/3 newest first")
    await keys("\x1b[6~")
    await seen("1/3 newest first")
    await keys("\x1b[6~")
    assert.ok((await text()).includes("1/3 newest first"), "Page Down wrapped at the newest comment")
    await resize(66, 18)
    await seen('1. "First synthetic phrase')
    const top = await text()
    for (let i = 0; i < 16; i++) await keys("\x1b[B")
    const scrolled = await text()
    assert.notEqual(scrolled, top, "Down did not scroll the comment body")
    assert.ok(scrolled.includes("1/3 newest first") && scrolled.includes("English teacher") && scrolled.includes("Esc close"), "Scrolling moved fixed chrome or changed the selected message")
    assert.ok(!scrolled.includes('1. "First synthetic phrase'), "Down did not move past the first correction")
    await keys("\x1b[A")
    assert.notEqual(await text(), scrolled, "Up did not scroll the body independently")
    await snapshot("scrolled")
    await keys("\x1b[5~")
    await seen("2/3 newest first")
    await keys("\x1b[6~")
    await seen('1. "First synthetic phrase')
    const dark = await colors()
    await theme("light")
    await test.until(async () => await colors() !== dark, "host theme updates the open teacher view")
    await seen("English teacher")
    await snapshot("light")
    await resize(48, 12)
    await seen("Esc close")
    await seen("PgUp older")
    await snapshot("short-narrow")
    await resize(100, 30)
    await keys("t")
    await seen("Analysis off")
    assert.equal((await test.rpc.status({ sessionID }, test.rpcOptions)).enabled, false)
    await seen("1/3 newest first")
    await keys("t")
    await seen("Analysis on")
    await keys("l")
    await seen("Comments · page 1 · 3 saved")
    await keys("\x1b[B")
    await keys("\r")
    await seen("2/3 newest first")
    await keys("l")
    await seen("Comments · page 1 · 3 saved")
    await keys("\x1b")
    await seen("2/3 newest first")
    await keys("\x1b")
    await test.until(async () => !(await text()).includes("newest first"), "Escape returns to coding session")
    await keys("\x10")
    await keys("English teacher")
    await seen("English teacher")
    await snapshot("palette")
    await keys("\r")
    await seen("1/3 newest first")
    await seen('1. "First synthetic phrase')
    await keys("\x1b")
    await test.until(async () => !(await text()).includes("newest first"), "palette view closes cleanly")
    assert.equal(test.requests.length, calls, "Teacher navigation submitted an unintended prompt")
    assert.deepEqual(await test.client.session.context({ sessionID }), history, "Teacher input modified coding history")
    assert.deepEqual(await test.client.session.inbox.list({ sessionID }), inbox, "Teacher input modified the inbox")
    test.checks.push("installed cross-session correction toast identifies its source, contains no correction body, and preserves current teacher selection")
    completed = true
  } finally {
    await snapshot("last-screen")
    if (!ended) child.write("\x03\x03")
    const kill = setTimeout(() => { if (!ended) child.kill() }, 8_000)
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const code = await Promise.race([exited, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Owned TUI did not exit")), 12_000) })])
      if (completed) assert.equal(code, 0, "Owned TUI did not exit cleanly")
    } finally {
      clearTimeout(kill)
      clearTimeout(timeout)
      if (!ended || process.platform === "win32") child.kill()
      await pending
      screen.dispose()
      await test.save("tui-output.log", raw)
    }
  }
}
