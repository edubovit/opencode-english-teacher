import assert from "node:assert/strict"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { once } from "node:events"
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createServer, type ServerResponse } from "node:http"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { OpenCode, type OpenCodeClient, type RpcEventPayload } from "@opencode/client"
import { EnglishTeacher } from "../src/rpc.ts"
import { PLUGIN_ID, type Correction } from "../src/contracts.ts"

export const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..")
export const providerID = "english-smoke-fixture"
const hostRevision = "9bbb8ce18c80f099e0e448775f59d965ead40a21"
const headerEvidence = {
  revision: hostRevision,
  session: `https://github.com/anomalyco/opencode/blob/${hostRevision}/packages/core/src/session/model-request.ts`,
  stateless: `https://github.com/anomalyco/opencode/blob/${hostRevision}/packages/core/src/generate.ts`,
}
const teacherContract = "You are an English writing teacher, not a coding assistant."
export const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII="
export type Wire = { model: string; messages: { role: string; content: unknown }[]; stream?: boolean; tools?: unknown[]; [key: string]: unknown }
export type Captured = { kind: "teacher" | "coding"; wire: Wire; sessionID?: string; attribution: string; closed: boolean; finished: boolean }
type Reply = { text: string; held?: boolean }
export type CorrectedEvent = RpcEventPayload<typeof EnglishTeacher, "corrected">

export async function fingerprint(directory: string, nested = false): Promise<string> {
  const hash = createHash("sha256")
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!nested && !["server.ts", "tui.ts", "src", "dist", "package.json", "README.md"].includes(entry.name)) continue
    const path = join(directory, entry.name)
    hash.update(entry.name)
    hash.update(entry.isDirectory() ? await fingerprint(path, true) : await readFile(path))
  }
  return hash.digest("hex")
}

export async function fixture(options: { plugin?: string; pack?: boolean } = {}) {
  const executable = process.env.OPENCODE_BIN ?? (process.platform === "win32"
    ? join(dirname(process.execPath), "node_modules", "@opencode", "cli", "bin", "opencode.exe") : "opencode")
  assert.ok(!/\.(cmd|ps1)$/i.test(executable), "OPENCODE_BIN must name the native executable, not an npm shim")
  const base = join(tmpdir(), "opencode")
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, "english-host-smoke-"))
  const workspace = join(root, "workspace")
  const configDirectory = join(root, "config", "opencode")
  const configPath = join(configDirectory, "opencode.json")
  const password = `synthetic-${randomUUID()}`
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  const deadline = AbortSignal.timeout(600_000)
  const env: NodeJS.ProcessEnv = {}
  for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "OS", "PROCESSOR_ARCHITECTURE"]) {
    if (process.env[key]) env[key] = process.env[key]
  }
  for (const [key, value] of Object.entries({
    HOME: "home", USERPROFILE: "home", OPENCODE_TEST_HOME: "home", XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data",
    XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state", APPDATA: "appdata", LOCALAPPDATA: "localappdata", ProgramData: "programdata",
    TEMP: "temp", TMP: "temp", TMPDIR: "temp",
  })) {
    env[key] = join(root, value)
    await mkdir(env[key], { recursive: true })
  }
  await mkdir(workspace)
  await mkdir(configDirectory, { recursive: true })
  Object.assign(env, {
    OPENCODE_CONFIG_DIR: configDirectory, OPENCODE_CONFIG_PROJECT_DISABLE: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_FFF: "true", OPENCODE_PASSWORD: password,
    OPENCODE_LOG_LEVEL: "DEBUG", OPENCODE_DB: join(root, "data", "smoke.db"), LANG: "C.UTF-8", TERM: "xterm-256color",
    npm_config_userconfig: join(root, "npmrc"), npm_config_globalconfig: join(root, "global-npmrc"),
    npm_config_cache: join(root, "cache", "npm"), npm_config_registry: "https://registry.npmjs.org/",
  })
  await writeFile(env.npm_config_userconfig!, "")
  await writeFile(env.npm_config_globalconfig!, "")
  const version = spawnSync(executable, ["--version"], { cwd: workspace, env, encoding: "utf8", timeout: 20_000, windowsHide: true })
  assert.equal(version.status, 0, `Cannot execute native OpenCode; set OPENCODE_BIN. Artifacts: ${root}`)
  assert.match(version.stdout, /^opencode v2\.2\.5\s*$/, "This harness targets OpenCode 2.2.5")
  const sanitize = (value: string) => value.replaceAll(password, "[test-password]").replaceAll(authorization, "[test-authorization]")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
  let stage = "setup"
  let host: ChildProcess | undefined
  let hostURL = ""
  let hostOutput = ""
  let fixtureError: unknown
  let client: OpenCodeClient
  let eventAbort = new AbortController()
  let eventTask: Promise<void> | undefined
  let eventConnected = false
  const requests: Captured[] = []
  const corrected: CorrectedEvent[] = []
  const replies = new Map<string, Reply>()
  const holds = new Map<string, { response: ServerResponse; finish(): void; captured: Captured }>()
  const checks: string[] = []
  const source = resolve(options.plugin ?? repository)
  const sourceFingerprint = await fingerprint(source)
  let plugin = source

  const until = async <T>(condition: () => T | Promise<T>, label: string, timeout = 30_000): Promise<NonNullable<T>> => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      deadline.throwIfAborted()
      if (fixtureError) throw fixtureError
      assert.ok(!host || (host.exitCode === null && host.signalCode === null), "Owned private host exited unexpectedly")
      const value = await condition()
      if (value) return value as NonNullable<T>
      await delay(50, undefined, { signal: deadline })
    }
    throw new Error(`Timed out: ${label}`)
  }
  const quiet = async (milliseconds = 500) => {
    await delay(milliseconds, undefined, { signal: deadline })
    if (fixtureError) throw fixtureError
  }
  const provider = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, "POST", "Unexpected fake-provider method")
      assert.equal(request.url, "/v1/chat/completions", "Unexpected fake-provider route")
      let raw = ""
      for await (const chunk of request) {
        raw += chunk
        assert.ok(raw.length < 4 * 1024 * 1024, "Fake-provider request exceeded bound")
      }
      const wire = JSON.parse(raw) as Wire
      assert.ok(Array.isArray(wire.messages), "Missing native chat messages")
      assert.ok(requests.length < 150, "Unexpected model-call loop")
      const sessionID = request.headers["x-opencode-session-id"]?.toString()
      const attribution = request.headers["x-opencode-session"]?.toString()
      const serialized = JSON.stringify(wire)
      assert.ok(typeof attribution === "string" && attribution.startsWith("ses"), "Missing 2.2.5 request attribution header")
      assert.equal(serialized.includes(teacherContract), !sessionID, "Session header and fixed teacher contract disagree")
      const captured: Captured = { wire, kind: sessionID ? "coding" : "teacher", sessionID, attribution, closed: false, finished: false }
      requests.push(captured)
      response.on("close", () => { captured.closed = true })
      let text = "Synthetic assistant response. ASSISTANT_CONTEXT_SENTINEL."
      let marker: string | undefined
      if (captured.kind === "teacher") {
        assert.equal(wire.messages.length, 1, "Teacher received conversation context")
        assert.equal(wire.messages[0].role, "user", "Teacher has an unexpected role")
        assert.ok(typeof wire.messages[0].content === "string" || (Array.isArray(wire.messages[0].content)
          && wire.messages[0].content.every(part => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")), "Teacher received non-text parts")
        const teacherPrompt = typeof wire.messages[0].content === "string" ? wire.messages[0].content
          : (wire.messages[0].content as { text: string }[]).map(part => part.text).join("")
        assert.ok(teacherPrompt.startsWith(teacherContract), "Teacher request lost its fixed contract")
        assert.equal(teacherPrompt.split("ISOLATED_MESSAGE_JSON:").length, 2, "Teacher request has an ambiguous message boundary")
        assert.equal(wire.tools?.length ?? 0, 0, "Teacher received tools")
        assert.doesNotMatch(serialized, /PRIOR_CONTEXT_SENTINEL|ASSISTANT_CONTEXT_SENTINEL|REPOSITORY_INSTRUCTIONS_SENTINEL|ATTACHMENT_SENTINEL|SESSION_METADATA_SENTINEL|data:image|image_url|tool_calls/)
        const matches = [...replies.keys()].filter(key => serialized.includes(key))
        assert.equal(matches.length, 1, "Teacher did not isolate exactly one submitted input")
        marker = matches[0]
        text = replies.get(marker)!.text
      }
      const finish = () => {
        if (response.destroyed || response.writableEnded) return
        const envelope = { id: `fixture-${randomUUID()}`, created: 1, model: wire.model }
        const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        if (wire.stream) {
          response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
          response.write(`data: ${JSON.stringify({ ...envelope, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`)
          response.write(`data: ${JSON.stringify({ ...envelope, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`)
          response.end("data: [DONE]\n\n")
        } else {
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...envelope, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage }))
        }
        captured.finished = true
      }
      const codingHold = captured.kind === "coding" && JSON.stringify(wire.messages.at(-1)).includes("coding hold")
      if (marker && replies.get(marker)!.held || codingHold) {
        const key = codingHold ? `coding:${sessionID}` : marker!
        assert.ok(!holds.has(key), "Duplicate held request")
        holds.set(key, { response, finish, captured })
      } else finish()
    })().catch(error => {
      fixtureError = error
      if (!response.headersSent) response.writeHead(500)
      response.end("Synthetic provider contract failed")
    })
  })
  provider.requestTimeout = 45_000
  provider.headersTimeout = 10_000

  const stop = async () => {
    eventAbort.abort()
    await eventTask
    if (!host || host.exitCode !== null || host.signalCode !== null) return
    const exited = once(host, "exit")
    host.kill()
    const timer = setTimeout(() => host?.kill("SIGKILL"), 8_000)
    let timeout: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([exited, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Owned host did not exit")), 12_000) })]) }
    finally { clearTimeout(timer); clearTimeout(timeout) }
    host = undefined
  }
  const save = async (name: string, value: string) => { await writeFile(join(root, name), sanitize(value)) }
  const close = async (passed: boolean, error?: unknown) => {
    let cleanupError: unknown
    try { await stop() } catch (failure) { cleanupError = failure }
    for (const hold of holds.values()) hold.response.destroy()
    provider.closeAllConnections()
    if (provider.listening) await new Promise<void>((done, reject) => provider.close(error => error ? reject(error) : done()))
    const unchanged = sourceFingerprint === await fingerprint(source)
    if (!unchanged) cleanupError = new Error("Production source changed during smoke; result invalidated")
    await save("host-output.log", hostOutput)
    await save("host.log", await readFile(join(root, "data", "opencode", "log", "opencode.log"), "utf8").catch(() => ""))
    await save("requests.json", JSON.stringify(requests, null, 2))
    await save("result.json", JSON.stringify({ passed: passed && !cleanupError, stage, checks, version: "2.2.5", headerEvidence, plugin, sourceUnchanged: unchanged,
      error: error instanceof Error ? error.stack : error, cleanupError: cleanupError instanceof Error ? cleanupError.message : cleanupError }, null, 2))
    await rm(configPath, { force: true })
    if (cleanupError) throw cleanupError
  }
  const start = async () => {
    hostURL = ""
    let output = ""
    host = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: workspace, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    host.on("error", error => { fixtureError = error })
    for (const stream of [host.stdout, host.stderr]) stream!.on("data", chunk => {
      output = (output + chunk).slice(-256_000)
      hostOutput = (hostOutput + chunk).slice(-2_000_000)
      hostURL ||= output.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1] ?? ""
    })
    await until(() => hostURL, "private server startup")
    const boundedFetch: typeof fetch = (input, init) => fetch(input, { ...init, redirect: "error",
      signal: AbortSignal.any([deadline, ...(init?.signal ? [init.signal] : []), AbortSignal.timeout(30_000)]) })
    client = OpenCode.make({ baseUrl: hostURL, headers: { authorization }, fetch: boundedFetch })
    const info = await client.server.info()
    assert.equal(info.version, "2.2.5")
    assert.equal(info.pid, host.pid, "Connected to a host we do not own")
    assert.ok(resolve(info.paths.tmp).startsWith(root + sep), "Host temp directory is not isolated")
    eventAbort = new AbortController()
    eventConnected = false
    eventTask = (async () => {
      try {
        const response = await fetch(`${hostURL}/api/event`, { headers: { authorization }, redirect: "error", signal: AbortSignal.any([deadline, eventAbort.signal]) })
        assert.ok(response.ok && response.body, "Private event stream failed")
        let buffered = ""
        for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
          buffered += chunk
          assert.ok(buffered.length < 2_000_000, "Event buffer exceeded bound")
          let end: number
          while ((end = buffered.indexOf("\n")) >= 0) {
            const line = buffered.slice(0, end).trimEnd()
            buffered = buffered.slice(end + 1)
            if (!line.startsWith("data:")) continue
            const event = JSON.parse(line.slice(5))
            if (event.type === "server.connected") eventConnected = true
            if (event.type === "rpc.english-teacher.corrected") corrected.push(event)
          }
        }
        if (!eventAbort.signal.aborted) throw new Error("Private event stream ended")
      } catch (error) { if (!eventAbort.signal.aborted) fixtureError = error }
    })()
    await until(() => eventConnected, "private event subscription")
  }
  let config: Record<string, unknown>
  const writeOptions = async (options: Record<string, unknown>) => {
    config.plugins = ["-opencode.provider.*", { package: pathToFileURL(plugin).href, options }]
    await writeFile(configPath, JSON.stringify(config, null, 2))
  }
  const loaded = async () => {
    await until(async () => {
      const list = (await client.plugin.list({ location: { directory: workspace } })).data
      assert.ok(list.every(item => item.source.type === "builtin" || item.id === PLUGIN_ID), "Unexpected external plugin loaded")
      const entry = list.find(item => item.id === PLUGIN_ID)
      if (entry?.state.status === "failed") throw new Error(`Production entrypoint failed: ${entry.state.error}`)
      return entry?.state.status === "active" && entry.features.server && entry.features.tui
    }, "production server/TUI discovery")
    const models = (await client.model.list({ location: { directory: workspace } })).data
    assert.equal(models.length, 2, "Unexpected provider model inventory")
    assert.ok(models.every(model => model.providerID === providerID), "A non-fixture model is available")
    assert.deepEqual(await client.credential.list(), [], "Private host discovered credentials")
  }

  try {
    if (options.pack) {
      stage = "fresh npm pack/install"
      let npm = process.env.NPM_CLI ?? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
      if (!process.env.NPM_CLI) {
        try { npm = join(dirname(createRequire(import.meta.url).resolve("npm/package.json")), "bin", "npm-cli.js") } catch {}
      }
      await access(npm)
      const runNpm = (args: string[], cwd: string) => {
        const result = spawnSync(process.execPath, [npm, ...args], { cwd, env, encoding: "utf8", timeout: 180_000, maxBuffer: 4_000_000, windowsHide: true })
        hostOutput += sanitize(result.stdout + result.stderr)
        assert.equal(result.status, 0, `Isolated npm ${args[0]} failed; see artifacts at ${root}`)
        return result.stdout
      }
      const packResult: unknown = JSON.parse(runNpm(["pack", source, "--json", "--ignore-scripts", "--pack-destination", root], workspace))
      assert.ok(packResult && typeof packResult === "object", "Unexpected npm pack response")
      const packed = (Array.isArray(packResult) ? packResult : Object.values(packResult)) as { filename: string }[]
      assert.equal(packed.length, 1)
      assert.equal(typeof packed[0].filename, "string")
      const install = join(root, "install")
      await mkdir(install)
      await writeFile(join(install, "package.json"), JSON.stringify({ name: "english-smoke-install", private: true, version: "0.0.0" }))
      runNpm(["install", join(root, packed[0].filename), "--ignore-scripts", "--no-audit", "--no-fund", "--legacy-peer-deps", "--registry=https://registry.npmjs.org/"], install)
      plugin = join(install, "node_modules", PLUGIN_ID)
      await access(join(plugin, "server.ts"))
      await access(join(plugin, "tui.ts"))
      assert.equal(await fingerprint(plugin), sourceFingerprint, "Packed production contents differ from source")
      checks.push("fresh npm pack and install (isolated npm config/cache; public package downloads only)")
    }
    provider.listen(0, "127.0.0.1")
    await once(provider, "listening")
    const address = provider.address()
    assert.ok(address && typeof address === "object")
    const model = {
      capabilities: { tools: true, input: ["text", "image"], output: ["text"] }, limit: { context: 100_000, output: 4096 },
      variants: [{ id: "low", settings: { reasoningEffort: "low" } }, { id: "high", settings: { reasoningEffort: "high" } }],
    }
    config = {
      $schema: "https://opencode.ai/config.json", model: `${providerID}/source`,
      providers: { [providerID]: { package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "synthetic-no-credential", encoding: "none", transport: "http" },
        models: { source: model, teacher: model } } },
      policies: [{ action: "provider.use", resource: "*", effect: "deny" }, { action: "provider.use", resource: providerID, effect: "allow" }],
      permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "read", resource: "*", effect: "allow" }],
      agents: {
        build: { system: "Synthetic coding fixture. REPOSITORY_INSTRUCTIONS_SENTINEL." },
        "fixture-agent": { mode: "primary", model: `${providerID}/teacher#low`, system: "Synthetic selected-agent fixture. REPOSITORY_INSTRUCTIONS_SENTINEL." },
        "fixture-default": { mode: "primary", system: "Synthetic location-default fixture. REPOSITORY_INSTRUCTIONS_SENTINEL." },
      },
      update: "disable", snapshots: false, formatter: false, compaction: { auto: false }, warming: false,
    }
    await writeFile(join(workspace, "AGENTS.md"), "Synthetic repository instructions. REPOSITORY_INSTRUCTIONS_SENTINEL.\n")
    await writeOptions({})
    stage = "private host startup"
    await start()
    await loaded()
  } catch (error) {
    await close(false, error)
    throw new Error(`Fixture setup failed; sanitized artifacts: ${root}`, { cause: error })
  }

  return {
    root, workspace, executable, env, requests, corrected, checks, until, quiet, loaded, writeOptions, save, close,
    get client() { return client }, get url() { return hostURL }, get rpc() { return client.rpc(EnglishTeacher) },
    get rpcOptions() { return { location: { directory: workspace }, signal: AbortSignal.any([deadline, AbortSignal.timeout(15_000)]) } },
    stage(label: string) { stage = label; console.log(`SYNTHETIC ONLY: ${label}`) },
    teachers() { return requests.filter(request => request.kind === "teacher") },
    reply(marker: string, corrections: Correction[] | string, held = false) {
      assert.ok(!replies.has(marker), "Fixture markers must be unique")
      replies.set(marker, { text: typeof corrections === "string" ? corrections : JSON.stringify({ corrections }), held })
    },
    held(marker: string) { return holds.get(marker)?.captured },
    release(marker: string) { const hold = holds.get(marker); assert.ok(hold, "No held request"); hold.finish() },
    async restart() { await stop(); await start(); await loaded() },
  }
}

export type HostFixture = Awaited<ReturnType<typeof fixture>>
