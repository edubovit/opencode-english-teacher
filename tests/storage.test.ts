import assert from "node:assert/strict"
import test from "node:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import type { Comment } from "../src/contracts.ts"
import { createStore, reserveSession } from "../src/storage.ts"
import { memoryStorage, model } from "./server-fixtures.ts"

function comment(order: number, sessionID = "one"): Comment {
  return {
    id: `message-${order}`, sessionID, preview: "This gives advices.", sourceTime: order,
    completedAt: 1000 - order, model,
    corrections: [{ original: "gives advices", replacement: "gives advice" }],
  }
}

test("storage orders by admission, pages bounded bodies, and keeps stable navigation anchors", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const memory = memoryStorage()
    const store = createStore(memory.storage)
    for (const order of [2, 1, 4, 3]) yield* store.save(comment(order), order, () => true)
    assert.equal((yield* store.view("one")).comment?.id, "message-4")
    assert.equal((yield* store.view("one", "message-3", "older")).comment?.id, "message-2")
    assert.equal((yield* store.view("one", "message-3", "newer")).comment?.id, "message-4")
    assert.equal((yield* store.view("one", "message-1", "older")).comment?.id, "message-1")
    assert.equal((yield* store.view("one", "message-4", "newer")).comment?.id, "message-4")
    const first = yield* store.list("one", undefined, 2)
    assert.deepEqual(first.items.map((item) => item.id), ["message-4", "message-3"])
    assert.equal(first.total, 4)
    yield* store.save(comment(5), 5, () => true)
    const next = yield* store.list("one", first.next!, 2)
    assert.deepEqual(next.items.map((item) => item.id), ["message-2", "message-1"])
    assert.equal(next.next, null)
    assert.equal((yield* store.view("one", "message-3")).position, 3)
    assert.equal(yield* store.save(comment(3), 3, () => true), false)
    assert.equal((yield* store.state("one")).count, 5)
  }))
})

test("history browsing loads only requested bodies, not all stored corrections", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const memory = memoryStorage()
    const store = createStore(memory.storage)
    for (let order = 1; order <= 240; order++) yield* store.save(comment(order), order, () => true)
    memory.reads.length = 0
    memory.scans.length = 0
    assert.equal((yield* store.state("one")).count, 240)
    assert.equal(memory.scans.length, 0)
    const page = yield* store.list("one", undefined, 3)
    assert.equal(page.items.length, 3)
    assert.equal(memory.reads.filter((key) => key.includes("/comment/")).length, 3)
    memory.reads.length = 0
    const old = yield* store.view("one", "message-1")
    assert.equal(old.position, 240)
    assert.equal(memory.reads.filter((key) => key.includes("/comment/")).length, 1)
    assert.ok(memory.scans.every((scan) => scan.limit! <= 100))
  }))
})

test("settings and corrections survive new stores; forks and encoded identities remain independent", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const memory = memoryStorage()
    const store = createStore(memory.storage)
    yield* store.setEnabled("one", false)
    yield* store.save(comment(1), 1, () => true)
    yield* store.save(comment(1, "one/child"), 1, () => true)
    const reload = createStore(memory.storage)
    assert.equal((yield* reload.state("one")).enabled, false)
    assert.equal((yield* reload.view("one")).total, 1)
    assert.deepEqual(yield* reload.state("fork"), { version: 1, sessionID: "fork", count: 0 })
    yield* reload.purge("one")
    assert.equal((yield* reload.view("one")).total, 0)
    assert.equal((yield* reload.view("one/child")).total, 1)
  }))
})

test("interrupted storage commits are rolled back, never replayed or counted as successful", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const memory = memoryStorage()
    const store = createStore(memory.storage)
    yield* store.save(comment(1), 1, () => true)
    memory.onSet((key) => { if (key.includes("/index/")) throw new Error("secret storage contents") })
    const failure = yield* Effect.exit(store.save(comment(2), 2, () => true))
    assert.ok(Exit.isFailure(failure))
    memory.onSet()
    const reload = createStore(memory.storage)
    assert.equal((yield* reload.state("one")).count, 1)
    assert.deepEqual((yield* reload.list("one")).items.map((item) => item.id), ["message-1"])
    assert.ok(![...memory.data.keys()].some((key) => key.endsWith("message-2")))
  }))
})

test("stale authority during a write cannot leave a saved comment", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const memory = memoryStorage()
    const store = createStore(memory.storage)
    let valid = true
    memory.onSet((key) => { if (key.includes("/comment/")) valid = false })
    assert.equal(yield* store.save(comment(1), 1, () => valid), false)
    assert.equal((yield* store.state("one")).count, 0)
    assert.deepEqual((yield* store.list("one")).items, [])
  }))
})

test("unknown/corrupt persisted schemas are preserved and foreign cursors are refused", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const memory = memoryStorage()
    const store = createStore(memory.storage)
    memory.data.set("v1/session/one/state", { version: 2, sessionID: "one", count: 4 })
    assert.ok(Exit.isFailure(yield* Effect.exit(store.state("one"))))
    assert.deepEqual(memory.data.get("v1/session/one/state"), { version: 2, sessionID: "one", count: 4 })
    assert.ok(Exit.isFailure(yield* Effect.exit(store.list("two", "v1/session/one/index/anything"))))
  }))
})

test("canceling a reserved middle operation never bypasses the current session owner", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const first = reserveSession("reserved")
    const middle = reserveSession("reserved")
    const last = reserveSession("reserved")
    const release = yield* Deferred.make<void>()
    const holder = yield* first.run(Deferred.await(release)).pipe(Effect.forkScoped({ startImmediately: true }))
    const canceled = yield* middle.run(Effect.void).pipe(Effect.forkScoped({ startImmediately: true }))
    let entered = false
    const follower = yield* last.run(Effect.sync(() => { entered = true })).pipe(Effect.forkScoped({ startImmediately: true }))
    yield* Fiber.interrupt(canceled)
    for (let i = 0; i < 10; i++) yield* Effect.yieldNow
    assert.equal(entered, false)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(holder)
    yield* Fiber.join(follower)
    assert.equal(entered, true)
  })))
})

test("abandoned prepared comments and settings remain recoverable across store instances", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const memory = memoryStorage()
    const store = createStore(memory.storage)
    yield* store.save(comment(1), 1, () => true)
    yield* store.setEnabled("one", false)
    const unpublished = yield* store.prepare(comment(2), 2, () => true)
    assert.equal(unpublished?.count, 2)
    assert.equal(unpublished?.pending?.count, 1)
    const fresh = createStore(memory.storage)
    assert.equal((yield* fresh.state("one")).count, 1)
    assert.deepEqual((yield* fresh.list("one")).items.map((item) => item.id), ["message-1"])
    yield* fresh.prepareEnabled("one", true, () => true)
    const next = createStore(memory.storage)
    assert.equal((yield* next.state("one")).enabled, false)
    assert.equal((yield* next.state("one")).count, 1)
  }))
})
