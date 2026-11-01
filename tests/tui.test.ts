import assert from "node:assert/strict"
import { test } from "node:test"
import type { Context } from "@opencode/plugin/tui/context"
import { teacherRemote, watchTeacher } from "../src/ui/client.ts"
import { TeacherModel } from "../src/ui/model.ts"
import { comment, deferred, fixture, type CommentList, type View } from "./tui-fixtures.ts"

test("latest, boundaries, source-order navigation and live selection preservation", async () => {
  const { data, remote } = fixture()
  const model = new TeacherModel(remote)
  await model.refresh()
  assert.equal(model.state.view?.comment?.id, "newest")
  await model.navigate("newer")
  assert.equal(model.state.view?.position, 1)
  await model.navigate("older")
  await model.navigate("older")
  assert.equal(model.state.view?.comment?.id, "older")
  data.items.unshift(comment("late-newest"))
  await model.refresh()
  assert.equal(model.state.view?.comment?.id, "older")
  assert.equal(model.state.view?.position, 3)
  await model.navigate("newer")
  assert.equal(model.state.view?.comment?.id, "newest")
  model.dispose()
  const reopened = new TeacherModel(remote)
  await reopened.refresh()
  assert.equal(reopened.state.view?.comment?.id, "late-newest")
  reopened.dispose()
})

test("queued live refresh cannot race navigation or a server-authoritative toggle", async () => {
  const { data, remote, status } = fixture()
  const model = new TeacherModel(remote)
  await model.refresh()
  const gate = deferred<View>()
  const original = remote.view
  remote.view = async () => gate.promise
  const navigation = model.navigate("older")
  model.changed()
  assert.equal(model.state.view?.comment?.id, "newest")
  remote.view = original
  gate.resolve({ status: status(), comment: data.items[1], position: 2, total: 2 })
  await navigation
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(model.state.view?.comment?.id, "older")
  const toggle = deferred<ReturnType<typeof status>>()
  remote.setEnabled = () => toggle.promise
  const changing = model.toggle()
  assert.equal(model.state.view?.status.enabled, true)
  model.changed()
  data.enabled = false
  toggle.resolve(status())
  await changing
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(model.state.view?.status.enabled, false)
  model.dispose()
})

test("bounded history pages select, return to prior comment, preserve identity on events", async () => {
  const { remote } = fixture(Array.from({ length: 45 }, (_, i) => comment(`item-${i}`)))
  const model = new TeacherModel(remote)
  await model.refresh()
  await model.openList()
  for (let i = 0; i < 21; i++) await model.select(1)
  assert.equal(model.state.page?.items.length, 20)
  assert.equal(model.state.page?.items[model.state.selected].id, "item-21")
  model.changed()
  assert.equal(model.state.page?.items[model.state.selected].id, "item-21")
  assert.equal(model.state.listStale, true)
  await new Promise(resolve => setImmediate(resolve))
  model.back()
  assert.equal(model.state.view?.comment?.id, "item-0")
  await model.openList()
  await model.openSelected()
  assert.equal(model.state.view?.comment?.id, "item-21")
  await model.openList()
  await model.page("newer")
  assert.equal(model.state.selected, 19)
  await model.page("older")
  await model.page("older")
  assert.equal(model.state.page?.items.length, 5)
  await model.page("older")
  assert.equal(model.state.pageIndex, 2)
  model.dispose()
})

test("back/dispose cancels pending reads and prevents late state publication", async () => {
  const { remote, status } = fixture()
  const model = new TeacherModel(remote)
  await model.refresh()
  const page = deferred<CommentList>()
  let signal!: AbortSignal
  remote.list = (_, value) => { signal = value; return page.promise }
  const loading = model.openList()
  model.back()
  assert.equal(signal.aborted, true)
  page.resolve({ items: [comment("late")], next: null, total: 1 })
  await loading
  assert.equal(model.state.page, undefined)
  const read = deferred<View>()
  remote.view = (_, value) => { signal = value; return read.promise }
  const refresh = model.refresh()
  let updates = 0
  model.subscribe(() => updates++)
  model.dispose()
  read.resolve({ status: status(), comment: comment("disposed"), position: 1, total: 1 })
  await refresh
  assert.equal(signal.aborted, true)
  assert.equal(updates, 0)
  assert.notEqual(model.state.view?.comment?.id, "disposed")
})

test("empty, child, disabled and failed operations remain distinct", async () => {
  const { data, remote } = fixture([])
  const model = new TeacherModel(remote)
  await model.refresh()
  await model.toggle()
  assert.equal(model.state.view?.status.enabled, false)
  assert.equal(model.state.view?.comment, null)
  data.eligible = false
  await model.refresh()
  let toggles = 0
  remote.setEnabled = async () => { toggles++; throw Error("raw provider content") }
  await model.toggle()
  assert.equal(toggles, 0)
  data.eligible = true
  await model.refresh()
  await model.toggle()
  assert.match(model.state.error!, /Could not change/)
  assert.doesNotMatch(model.state.error!, /raw provider/)
  remote.view = async () => { throw Error("private body") }
  await model.refresh()
  assert.match(model.state.error!, /Could not load/)
  model.dispose()
})

test("each RPC resolves current session location and aborted lookups cannot dispatch", async () => {
  const calls: unknown[][] = []
  let directory = "project-a"
  const client = {
    session: { get: async () => ({ location: { directory } }) },
    rpc: () => ({ view: async (...args: unknown[]) => { calls.push(args); return {} }, list: async (...args: unknown[]) => { calls.push(args); return {} }, setEnabled: async (...args: unknown[]) => { calls.push(args); return {} } }),
  }
  const remote = teacherRemote({ client } as unknown as Context, "s")
  const scope = new AbortController()
  await remote.view({}, scope.signal)
  directory = "project-b"
  await remote.list("cursor", scope.signal)
  await remote.setEnabled(false, scope.signal)
  assert.deepEqual(calls.map(call => call[0]), [{ sessionID: "s" }, { sessionID: "s", limit: 20, cursor: "cursor" }, { sessionID: "s", enabled: false }])
  assert.deepEqual(calls.map(call => (call[1] as { location: unknown }).location), [{ directory: "project-a" }, { directory: "project-b" }, { directory: "project-b" }])
  scope.abort()
  await assert.rejects(remote.view({}, scope.signal))
  assert.equal(calls.length, 3)
})

test("live cross-session toasts deduplicate, validate ownership, do not navigate or replay", async () => {
  type Event = { location: { directory: string }; data: { sessionID: string; commentID: string; sessionTitle: string } }
  const listeners = new Map<string, (event: Event) => Promise<void> | void>()
  const toasts: unknown[] = []
  const changes: string[] = []
  let parentID: string | undefined
  let directory = "project"
  const session = () => ({ parentID, location: { directory }, title: "Another session" })
  let get = async () => session()
  const api = {
    client: { session: { get: () => get() }, rpc: () => ({ events: { on: (name: string, callback: (event: Event) => void) => { listeners.set(name, callback); return () => { listeners.delete(name) } } } }) },
    ui: { toast: { show: (toast: unknown) => toasts.push(toast) }, router: { navigate: () => assert.fail("Toast must not navigate") } },
  } as unknown as Context
  const seen = new Set<string>()
  const stop = watchTeacher(api, id => changes.push(id), seen)
  const event = (id: string): Event => ({ location: { directory: "project" }, data: { sessionID: "other-session", commentID: id, sessionTitle: "Fallback" } })
  await Promise.all([listeners.get("corrected")!(event("one")), listeners.get("corrected")!(event("one"))])
  assert.equal(toasts.length, 1)
  assert.match(JSON.stringify(toasts), /Another session.*\/english/)
  assert.doesNotMatch(JSON.stringify(toasts), /original|replacement/)
  parentID = "parent"
  await listeners.get("corrected")!(event("child"))
  parentID = undefined
  directory = "moved"
  await listeners.get("corrected")!(event("moved"))
  assert.equal(toasts.length, 1)
  directory = "project"
  listeners.get("changed")!(event("change"))
  assert.deepEqual(changes, ["other-session"])
  const late = deferred<ReturnType<typeof session>>()
  get = () => late.promise
  const pending = listeners.get("corrected")!(event("late"))
  stop()
  late.resolve(session())
  await pending
  assert.equal(toasts.length, 1)
  get = async () => session()
  const reconnected = watchTeacher(api, () => {}, seen)
  assert.equal(toasts.length, 1)
  await listeners.get("corrected")!(event("one"))
  assert.equal(toasts.length, 1)
  reconnected()
})
