import assert from "node:assert/strict"
import { test } from "node:test"
import { createSignal } from "solid-js"
import { testRender } from "@opentui/solid"
import { KeyCodes } from "@opentui/core/testing"
import type { BoxRenderable, ScrollBoxRenderable, TextRenderable } from "@opentui/core"
import { HueStep, MarkdownToken, SyntaxToken, parseThemeDocument, resolveThemeDocument } from "@opencode/theme/tui"
import { Teacher, type TeacherUI } from "../src/ui/teacher.tsx"
import { TeacherModel } from "../src/ui/model.ts"
import { comment, deferred, fixture, type View } from "./tui-fixtures.ts"
import plugin from "../tui.ts"
import type { Context, Destination, KeymapLayer, Page, Route, SlotClaim } from "@opencode/plugin/tui/context"

function themeFixture(mode: "dark" | "light" = "dark") {
  const primary = "#aaccff", muted = "#8899aa"
  const actions = { primary: { base: primary }, secondary: { base: muted }, destructive: { base: "#ff0000" } }
  const feedback = Object.fromEntries(["info", "warning", "success", "error"].map(kind => [kind, { base: primary, muted }]))
  const backgrounds = { added: "#112233", removed: "#332211", context: "#101014" }
  const scale = (color: string) => Object.fromEntries(HueStep.literals.map(step => [step, color]))
  const hue = { accent: scale("#ff0000"), interactive: scale("#00ff00"), neutral: scale(muted) }
  return resolveThemeDocument(parseThemeDocument({
    base: {
      categorical: ["accent"],
      text: { base: "#eeeeee", muted, action: actions, formfield: { base: "#dddddd", $focused: primary }, feedback },
      background: { base: "#101014", raised: { base: "#202028", high: "#303038", max: "#404048" }, action: actions, formfield: { base: "#101014", $selected: "#202028" }, feedback },
      border: { base: muted }, scrollbar: { base: muted },
      diff: { text: { ...backgrounds, hunkHeader: muted }, background: backgrounds, highlight: backgrounds, lineNumber: { text: muted, background: backgrounds } },
      syntax: Object.fromEntries(SyntaxToken.literals.map(token => [token, "$hue.neutral.500"])),
      markdown: Object.fromEntries(MarkdownToken.literals.map(token => [token, "$hue.neutral.500"])),
    },
    dark: { hue }, light: { hue, text: { base: "#101014" }, background: { base: "#ffffff" } },
  }), mode)
}

async function setup(t: { after(fn: () => void | Promise<void>): void }, width = 80, height = 24, options: { empty?: boolean; child?: boolean; noSession?: boolean; error?: string; disabled?: boolean } = {}) {
  const f = fixture(options.empty ? [] : [comment("newest", true), ...Array.from({ length: 25 }, (_, i) => comment(`older-${i}`))])
  f.data.eligible = !options.child
  f.data.enabled = !options.disabled
  f.data.error = options.error ?? null
  const read = f.remote.view
  f.remote.view = async (...args) => structuredClone(await read(...args))
  const model = new TeacherModel(f.remote)
  let mode = "base", closed = 0, released = 0
  const [theme, setTheme] = createSignal(themeFixture())
  const api = {
    get theme() { return theme() },
    keymap: { mode: { current: () => mode, push: (next: string) => { mode = next; return () => { released++; mode = "base" } } } },
  } as TeacherUI
  const screen = await testRender(() => <Teacher api={api} model={options.noSession ? undefined : model} title="Fixture session" close={() => { closed++ }} />, { width, height })
  t.after(async () => { model.dispose(); await screen.dispose() })
  const frame = () => screen.captureCharFrame()
  const settle = async () => { await new Promise(resolve => setTimeout(resolve, 25)); await screen.renderOnce(); await screen.renderOnce() }
  const until = async (predicate: () => boolean) => {
    for (let i = 0; i < 40; i++) { await settle(); if (predicate()) return }
    assert.fail(frame())
  }
  const key = async (name: string) => {
    screen.mockInput.pressKey(name)
    await settle()
  }
  await until(() => options.noSession ? frame().includes("Open a session first.") : !!model.state.view)
  return { ...f, model, screen, frame, settle, until, key, setTheme, setMode: (value: string) => { mode = value }, closed: () => closed, released: () => released }
}

for (const [width, height] of [[100, 30], [40, 12]]) test(`production comment wraps, scrolls and contains fixed chrome at ${width}x${height}`, async t => {
  const view = await setup(t, width, height)
  assert.match(view.frame(), /English teacher/)
  assert.match(view.frame(), /1\. "original newest/)
  assert.match(view.frame(), /Analysis on/)
  assert.match(view.frame(), /1\/26/)
  const body = view.screen.renderer.root.findDescendantById("english-body") as ScrollBoxRenderable
  const header = view.screen.renderer.root.findDescendantById("english-header") as BoxRenderable
  const hints = view.screen.renderer.root.findDescendantById("english-hints") as TextRenderable
  assert.ok(body.viewport.y >= header.y + header.height)
  assert.ok(body.viewport.y + body.viewport.height <= hints.y)
  assert.ok(body.scrollHeight > body.viewport.height)
  for (let i = 0; i < 8; i++) await view.key(KeyCodes.ARROW_DOWN)
  assert.ok(body.scrollTop > 0)
  assert.equal(view.model.state.view?.comment?.id, "newest")
  const scroll = body.scrollTop
  view.data.pending = 2
  await view.model.refresh()
  await view.settle()
  assert.equal(body.scrollTop, scroll)
  assert.match(view.frame(), /2 pending/)
  body.scrollTo(Infinity)
  await view.settle()
  assert.match(view.frame(), /END-4/)
  await view.key("\u001b[5~")
  assert.equal(view.model.state.view?.comment?.id, "older-0")
  assert.equal(body.scrollTop, 0)
  await view.key("\u001b[6~")
  assert.equal(view.model.state.view?.comment?.id, "newest")
  assert.match(view.frame(), /1\. "original newest/)
  const end = view.screen.renderer.root.findDescendantById("english-correction-4") as TextRenderable
  assert.ok(end.x >= body.viewport.x)
  assert.ok(end.x + end.width <= body.viewport.x + body.viewport.width)
})

test("single corrections are unnumbered and multiple corrections remain numbered", async t => {
  const view = await setup(t)
  assert.match(view.frame(), /1\. "original newest/)
  await view.key("\u001b[5~")
  assert.match(view.frame(), /"original older-0 0"/)
  assert.doesNotMatch(view.frame(), /1\. "original older-0/)
  await view.key("\u001b[6~")
  assert.match(view.frame(), /1\. "original newest/)
})

test("production history arrows, pagination, Enter and Escape preserve comment selection", async t => {
  const view = await setup(t, 60, 18)
  await view.key("l")
  assert.equal(view.model.state.mode, "list")
  for (let i = 0; i < 21; i++) await view.key(KeyCodes.ARROW_DOWN)
  assert.equal(view.model.state.pageIndex, 1)
  assert.equal(view.model.state.page?.items.length, 6)
  const selected = view.model.state.page!.items[view.model.state.selected].id
  view.data.items.unshift(comment("new-arrival"))
  view.model.changed()
  await view.settle()
  assert.equal(view.model.state.page!.items[view.model.state.selected].id, selected)
  assert.equal(view.model.state.listStale, true)
  const list = view.screen.renderer.root.findDescendantById("english-list") as ScrollBoxRenderable
  const row = view.screen.renderer.root.findDescendantById(`english-row-${selected}`) as BoxRenderable
  assert.ok(row.y >= list.viewport.y && row.y + row.height <= list.viewport.y + list.viewport.height)
  await view.key(KeyCodes.RETURN)
  assert.equal(view.model.state.view?.comment?.id, selected)
  await view.key("l")
  await view.key(KeyCodes.ARROW_UP)
  view.screen.mockInput.pressEscape()
  await view.settle()
  assert.equal(view.model.state.mode, "comment")
  assert.equal(view.model.state.view?.comment?.id, selected)
  assert.equal(view.closed(), 0)
  view.screen.mockInput.pressEscape()
  await view.until(() => view.closed() === 1)
})

test("native modal mode blocks every teacher navigation and toggle without changing selection", async t => {
  const view = await setup(t)
  view.setMode("modal")
  for (const key of ["t", "l", KeyCodes.ARROW_DOWN, "\u001b[5~", KeyCodes.RETURN]) await view.key(key)
  view.screen.mockInput.pressEscape()
  await view.settle()
  assert.equal(view.model.state.mode, "comment")
  assert.equal(view.model.state.view?.comment?.id, "newest")
  assert.equal(view.data.enabled, true)
  assert.equal(view.closed(), 0)
  const body = view.screen.renderer.root.findDescendantById("english-body") as ScrollBoxRenderable
  assert.equal(body.scrollTop, 0)
  view.setMode("english-teacher")
  await view.key("t")
  assert.equal(view.data.enabled, false)
  assert.match(view.frame(), /Analysis off/)
  assert.match(view.frame(), /1\. "original newest/)
})

test("live resolved theme, Unicode and resize keep content and navigation usable", async t => {
  const view = await setup(t)
  const title = view.screen.renderer.root.findDescendantById("english-title") as TextRenderable
  const root = view.screen.renderer.root.findDescendantById("english-teacher") as BoxRenderable
  const before = title.fg
  view.setTheme(themeFixture("light"))
  await view.settle()
  assert.notDeepEqual(title.fg, before)
  assert.deepEqual(root.backgroundColor, themeFixture("light").background.base)
  view.screen.resize(40, 10)
  await view.settle()
  assert.match(view.frame(), /Esc close/)
  assert.match(view.frame(), /PgUp older/)
  const body = view.screen.renderer.root.findDescendantById("english-body") as ScrollBoxRenderable
  body.scrollTo(Infinity)
  await view.settle()
  assert.match(view.frame(), /END-4/)
  view.screen.resize(110, 28)
  await view.settle()
  await view.key("\u001b[5~")
  assert.match(view.frame(), /café 日本語/)
  assert.equal(body.scrollTop, 0)
  await view.key("l")
  view.screen.resize(40, 12)
  await view.settle()
  await view.key(KeyCodes.ARROW_DOWN)
  const selected = view.model.state.page!.items[view.model.state.selected]
  const list = view.screen.renderer.root.findDescendantById("english-list") as ScrollBoxRenderable
  const row = view.screen.renderer.root.findDescendantById(`english-row-${selected.id}`) as BoxRenderable
  assert.ok(row.y + row.height <= list.viewport.y + list.viewport.height)
})

for (const options of [{ empty: true }, { empty: true, disabled: true }, { child: true, empty: true }, { noSession: true }, { empty: true, error: "Provider unavailable: check model configuration." }]) test(`production status state ${JSON.stringify(options)}`, async t => {
  const view = await setup(t, 60, 16, options)
  const text = view.frame()
  if (options.noSession) assert.match(text, /Open a session first\./)
  else if (options.child) {
    assert.match(text, /unavailable in child sessions/i)
    assert.doesNotMatch(text, /t off|t on/)
  } else {
    assert.match(text, /No comments yet\./)
    assert.match(text, options.disabled ? /Analysis off/ : /Analysis on/)
    if (options.error) assert.match(text, /Provider unavailable/)
  }
  assert.doesNotMatch(text, /English is correct/)
})

test("production unmount aborts pending request and revokes input mode", async t => {
  const view = await setup(t)
  const late = deferred<View>()
  let signal!: AbortSignal
  view.remote.view = (_, request) => { signal = request; return late.promise }
  const refresh = view.model.refresh()
  await view.screen.dispose()
  assert.equal(signal.aborted, true)
  assert.equal(view.released(), 1)
  late.resolve({ ...view.model.state.view!, comment: comment("late") })
  await refresh
  assert.equal(view.closed(), 0)
  assert.notEqual(view.model.state.view?.comment?.id, "late")
})

test("public entrypoint renews same-client subscriptions and reopens latest without host remount", async t => {
  const f = fixture([comment("saved")])
  type Listener = (event: unknown) => void | Promise<void>
  const listeners = new Map<string, Set<Listener>>()
  const signals: AbortSignal[] = []
  let page!: Page, slot!: SlotClaim<"app">, layer!: KeymapLayer
  let route: Route = { type: "session", sessionID: "session-a" }
  let destination: Destination | undefined
  let mode = "base", reads = 0, toasts = 0, subscriptions = 0, stopped = 0
  let connected!: () => void
  const api = {
    theme: themeFixture(),
    keymap: { layer: (factory: () => KeymapLayer) => { layer = factory() }, mode: { current: () => mode, push: (next: string) => { mode = next; return () => { mode = "base" } } } },
    data: { on: (_: string, callback: () => void) => { connected = callback; return () => {} }, session: { get: () => ({ title: "Source session" }) } },
    client: {
      session: { get: async () => ({ location: { directory: "source-location" } }) },
      rpc: () => ({
        view: async (input: { id?: string }, options: { location: { directory: string }; signal: AbortSignal }) => {
          assert.equal(options.location.directory, "source-location")
          reads++
          return f.remote.view(input, options.signal)
        },
        events: { on: (name: string, callback: Listener, options: { signal: AbortSignal }) => {
          subscriptions++
          signals.push(options.signal)
          const group = listeners.get(name) ?? new Set<Listener>()
          listeners.set(name, group)
          group.add(callback)
          return () => { stopped++; group.delete(callback) }
        } },
      }),
    },
    ui: {
      router: { register: (value: Page) => { page = value; return () => {} }, current: () => route, navigate: (value: Destination) => { destination = value } },
      slot: (value: SlotClaim<"app">) => { slot = value; return () => {} },
      toast: { show: () => { toasts++ } },
    },
  } as unknown as Context
  const cleanup = await plugin.setup(api)
  t.after(() => cleanup?.())
  assert.equal(layer.mode, "global")
  assert.equal(layer.commands?.length, 1)
  const command = layer.commands![0]
  assert.equal(command.title, "English teacher")
  assert.equal(command.slash?.name, "english")
  assert.equal(command.palette, true)
  assert.equal(command.bind, undefined)
  await command.run()
  assert.deepEqual(destination, { type: "plugin", name: "english", data: { sessionID: "session-a" } })
  const screen = await testRender(() => <>{slot.render({})}{page.render({ data: { sessionID: "session-a" } })}</>, { width: 80, height: 20 })
  t.after(() => screen.dispose())
  const settle = async () => { await new Promise(resolve => setTimeout(resolve, 30)); await screen.renderOnce(); await screen.renderOnce() }
  const corrected = async (commentID: string) => {
    const event = { location: { directory: "source-location" }, data: { sessionID: "session-a", sessionTitle: "Source session", commentID } }
    for (const callback of listeners.get("corrected") ?? []) await callback(event)
  }
  await settle()
  assert.match(screen.captureCharFrame(), /original saved/)
  assert.equal(subscriptions, 2)
  await corrected("before-disconnect")
  assert.equal(toasts, 1)
  const before = reads
  f.data.items.unshift(comment("missed-offline"))
  for (const group of listeners.values()) group.clear()
  connected()
  await settle()
  assert.equal(subscriptions, 4)
  assert.equal(stopped, 2)
  assert.ok(signals.slice(0, 2).every(signal => signal.aborted))
  assert.ok(signals.slice(2).every(signal => !signal.aborted))
  assert.ok([...listeners.values()].every(group => group.size === 1))
  assert.ok(reads > before)
  assert.match(screen.captureCharFrame(), /original saved/)
  assert.match(screen.captureCharFrame(), /2\/2/)
  assert.equal(toasts, 1)
  await corrected("before-disconnect")
  assert.equal(toasts, 1)
  await corrected("after-reconnect")
  assert.equal(toasts, 2)
  connected()
  await settle()
  assert.equal(subscriptions, 6)
  assert.equal(stopped, 4)
  assert.ok([...listeners.values()].every(group => group.size === 1))
  await corrected("after-reconnect")
  assert.equal(toasts, 2)
  await settle()
  assert.equal(subscriptions, 6)
  const late = deferred<View>()
  const read = f.remote.view
  let pendingSignal: AbortSignal | undefined
  f.remote.view = (selection, signal) => {
    if (selection.id === "saved") {
      pendingSignal = signal
      return late.promise
    }
    return read(selection, signal)
  }
  for (const callback of listeners.get("changed") ?? []) callback({ data: { sessionID: "session-a" } })
  await settle()
  assert.ok(pendingSignal)
  route = { type: "plugin", id: "opencode-english-teacher", name: "english", data: { sessionID: "session-a" } }
  await command.run()
  await settle()
  assert.equal(pendingSignal.aborted, true)
  assert.match(screen.captureCharFrame(), /original missed-offline/)
  assert.match(screen.captureCharFrame(), /1\/2/)
  late.resolve({ status: f.status(), comment: comment("saved"), position: 2, total: 2 })
  await settle()
  assert.match(screen.captureCharFrame(), /original missed-offline/)
  assert.equal(subscriptions, 6)
  assert.equal(toasts, 2)
  assert.equal(mode, "english-teacher")
  route = { type: "home" }
  await command.run()
  assert.deepEqual(destination, { type: "plugin", name: "english", data: {} })
})
