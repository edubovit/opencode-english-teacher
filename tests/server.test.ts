import assert from "node:assert/strict"
import test from "node:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { makePrompt, parseCorrections, prepareText } from "../src/analysis.ts"
import type { Options } from "../src/config.ts"
import { admissionFromEvent, admittedText, resolveSourceModel, type Catalog } from "../src/server.ts"
import { CONCURRENCY, createTeacher, DEADLINE_MS, MAX_INPUT, MAX_QUEUED } from "../src/service.ts"
import { createStore } from "../src/storage.ts"
import { admission, clean, corrected, eventually, fakeHost, memoryStorage, model, settled } from "./server-fixtures.ts"
import { PromptFileError } from "../src/prompt-file.ts"

const setup = Effect.fnUntraced(function* (options: Options | null = { enabledByDefault: true }, limits = {}) {
  const fake = fakeHost()
  const memory = memoryStorage()
  const store = createStore(memory.storage)
  const teacher = yield* createTeacher(fake.host, store, options, options ? null : "Invalid teacher configuration.", limits)
  return { ...fake, ...memory, store, teacher }
})

test("admission adapter accepts only same-location successful user text and excludes attachment bodies and mentions", () => {
  const payload = {
    text: "Please @agent check #skill and @file. This gives advices.",
    agents: [{ name: "agent", mention: { start: 7, end: 13, text: "@agent" } }],
    skills: [{ name: "skill", text: "SECRET_SKILL", mention: { start: 20, end: 26, text: "#skill" } }],
    files: [{ data: "SECRET_FILE", description: "SECRET_DESCRIPTION", mention: { start: 31, end: 36, text: "@file" } }],
  }
  const event = {
    type: "session.inbox.enqueued", created: 100, location: { directory: "project" }, durable: { seq: 21 },
    data: { sessionID: "one", inboxID: "message", item: { type: "user", payload } },
  }
  const selected = admissionFromEvent(event, "project")!
  assert.equal(selected.text, "Please [omitted] check [omitted] and [omitted]. This gives advices.")
  assert.ok(!JSON.stringify(selected).includes("SECRET"))
  assert.equal(admissionFromEvent(event, "other"), undefined)
  assert.equal(admissionFromEvent(event, "project", "different-workspace"), undefined)
  assert.equal(admissionFromEvent({ ...event, location: undefined }, "project"), undefined)
  for (const type of ["synthetic", "compaction", "move", "assistant", "tool", "shell"])
    assert.equal(admissionFromEvent({ ...event, data: { ...event.data, item: { type, payload } } }, "project"), undefined)
  assert.equal(admissionFromEvent({ ...event, type: "session.message.updated" }, "project"), undefined)
  assert.equal(admittedText({ text: "text", agents: [{ mention: { start: -1, end: 2, text: "te" } }] }), "text")
})

test("teacher guidance is loaded per request and file failures never call the provider", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = fakeHost()
    let instructions = "Focus on articles."
    let broken = false
    const teacher = yield* createTeacher({ ...f.host, instructions: () => broken
      ? Effect.fail(new PromptFileError()) : Effect.succeed(instructions) }, createStore(memoryStorage().storage), { enabledByDefault: true })
    yield* teacher.admit(admission(1))
    yield* eventually(() => f.calls.length === 1)
    assert.ok(f.calls[0].prompt.startsWith(instructions))
    yield* Deferred.succeed(f.calls[0].result, clean)
    yield* settled(teacher)
    instructions = "Focus on tenses."
    yield* teacher.admit(admission(2))
    yield* eventually(() => f.calls.length === 2)
    assert.ok(f.calls[1].prompt.startsWith(instructions))
    yield* Deferred.succeed(f.calls[1].result, clean)
    yield* settled(teacher)
    broken = true
    yield* teacher.admit(admission(3))
    yield* settled(teacher)
    assert.equal(f.calls.length, 2)
    assert.match((yield* teacher.status("one")).error!, /prompt/i)
  })))
})

test("stateless jobs are isolated, duplicates are ignored, and out-of-order completions retain source order", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* setup()
    const first = admission(1, "one", "This gives advices.\n```\nSECRET_CODE\n```")
    yield* f.teacher.admit(first)
    yield* f.teacher.admit(first)
    yield* f.teacher.admit(admission(2))
    yield* eventually(() => f.calls.length === 2)
    assert.equal(f.calls[0].prompt, makePrompt(prepareText(first.text)))
    assert.ok(!f.calls[0].prompt.includes("SECRET_CODE"))
    assert.ok(!f.calls[0].prompt.includes("Source session"))
    yield* Deferred.succeed(f.calls[1].result, corrected)
    yield* eventually(() => f.notifications.length === 1)
    yield* Deferred.succeed(f.calls[0].result, corrected)
    yield* settled(f.teacher)
    assert.equal((yield* f.teacher.view("one")).comment?.id, "message-2")
    assert.deepEqual(f.notifications, [
      { sessionID: "one", commentID: "message-2", sessionTitle: "Source session" },
      { sessionID: "one", commentID: "message-1", sessionTitle: "Source session" },
    ])
    yield* f.teacher.admit(first)
    assert.equal(f.calls.length, 2)
    assert.equal((yield* f.teacher.status("one")).count, 2)
  })))
})

test("children, foreign sessions, empty/code-only messages and disabled sessions never generate", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* setup()
    yield* f.teacher.admit(admission(1, "child"))
    yield* f.teacher.admit(admission(1, "foreign"))
    yield* f.teacher.admit(admission(1, "one", "```ts\nconst x = 1\n```"))
    yield* f.teacher.admit(admission(2, "one", ""))
    yield* f.teacher.setEnabled("two", false)
    yield* f.teacher.admit(admission(1, "two"))
    yield* f.teacher.admit(admission(2, "two", "x".repeat(MAX_INPUT + 1)))
    yield* settled(f.teacher)
    yield* settled(f.teacher, "child")
    yield* settled(f.teacher, "two")
    assert.equal(f.calls.length, 0)
    assert.equal((yield* f.teacher.status("two")).error, null)
    assert.equal((yield* f.teacher.status("child")).eligible, false)
    assert.ok(Exit.isFailure(yield* Effect.exit(f.teacher.setEnabled("child", true))))
    assert.ok(Exit.isFailure(yield* Effect.exit(f.teacher.status("foreign"))))
  })))
})

test("clean and malformed results remain outside history; failures expose no raw output", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* setup()
    yield* f.teacher.admit(admission(1))
    yield* eventually(() => f.calls.length === 1)
    yield* Deferred.succeed(f.calls[0].result, clean)
    yield* settled(f.teacher)
    assert.equal((yield* f.teacher.status("one")).error, null)
    yield* f.teacher.admit(admission(2))
    yield* eventually(() => f.calls.length === 2)
    yield* Deferred.succeed(f.calls[1].result, "SECRET invalid model output")
    yield* settled(f.teacher)
    const status = yield* f.teacher.status("one")
    assert.match(status.error!, /invalid correction/)
    assert.ok(!status.error?.includes("SECRET"))
    assert.equal(status.count, 0)
    assert.equal(f.notifications.length, 0)
    assert.deepEqual((yield* f.teacher.list("one")).items, [])
  })))
})

test("disable interrupts running work, rejects queued work and never replays on re-enable", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* setup(undefined, { concurrency: 1 })
    yield* f.teacher.admit(admission(1))
    yield* f.teacher.admit(admission(2))
    yield* eventually(() => f.calls.length === 1 && f.selections.length === 2)
    const disabled = yield* f.teacher.setEnabled("one", false)
    assert.equal(disabled.enabled, false)
    assert.equal(disabled.overridden, true)
    yield* eventually(() => f.calls[0].interrupted)
    yield* Deferred.succeed(f.calls[0].result, corrected)
    yield* f.teacher.setEnabled("one", true)
    yield* f.teacher.admit(admission(2))
    assert.equal(f.calls.length, 1)
    assert.equal((yield* f.teacher.status("one")).count, 0)
    yield* f.teacher.admit(admission(3))
    yield* eventually(() => f.calls.length === 2)
    yield* Deferred.succeed(f.calls[1].result, corrected)
    yield* settled(f.teacher)
    assert.equal((yield* f.teacher.status("one")).count, 1)
  })))
})

test("explicit settings survive reload, new defaults apply only without overrides, invalid config stays inert", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* setup({ enabledByDefault: false })
    yield* f.teacher.admit(admission(1))
    yield* settled(f.teacher)
    assert.equal(f.calls.length, 0)
    yield* f.teacher.setEnabled("one", true)
    yield* f.teacher.admit(admission(2))
    yield* eventually(() => f.calls.length === 1)
    yield* Deferred.succeed(f.calls[0].result, corrected)
    yield* settled(f.teacher)
    yield* f.teacher.stop()
    const next = yield* createTeacher(f.host, f.store, { enabledByDefault: false })
    assert.equal((yield* next.status("one")).enabled, true)
    assert.equal((yield* next.status("two")).enabled, false)
    assert.equal((yield* next.view("one")).total, 1)
    yield* next.stop()
    const invalid = yield* createTeacher(f.host, f.store, null, "Fix invalid teacher options.")
    yield* invalid.admit(admission(3))
    assert.equal((yield* invalid.status("one")).enabled, false)
    assert.match((yield* invalid.status("one")).error!, /invalid/)
    assert.equal((yield* invalid.view("one")).total, 1)
    assert.equal(f.calls.length, 1)
    assert.ok(Exit.isFailure(yield* Effect.exit(invalid.setEnabled("one", true))))
  })))
})

test("model and variant are frozen before queue wait; explicit override requires no source model", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* setup(undefined, { concurrency: 1 })
    yield* f.teacher.admit(admission(1))
    yield* f.teacher.admit(admission(2))
    yield* eventually(() => f.calls.length === 1 && f.selections.length === 2)
    f.sessions.get("one")!.model = { providerID: "changed", id: "new" }
    yield* Deferred.succeed(f.calls[0].result, clean)
    yield* eventually(() => f.calls.length === 2)
    assert.deepEqual(f.calls[1].model, model)
    yield* Deferred.succeed(f.calls[1].result, clean)
    yield* settled(f.teacher)
    const override = yield* createTeacher({ ...f.host, sourceModel: () => Effect.fail("must not read") }, f.store,
      { enabledByDefault: true, model: { providerID: "explicit", id: "teacher" } })
    yield* override.admit(admission(3))
    yield* eventually(() => f.calls.length === 3)
    assert.deepEqual(f.calls[2].model, { providerID: "explicit", id: "teacher" })
  })))
})

test("source-model adapter follows explicit session, selected/default agent and location default selection", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const standard = { providerID: "test", id: "default", package: "test", capabilities: { input: ["text"], output: ["text"] } }
    const agentModel = { providerID: "test", id: "agent", variant: "high" }
    const catalog: Catalog = {
      agents: () => Effect.succeed([{ id: "configured-default", model: agentModel }, { id: "other" }]),
      models: () => Effect.succeed([standard, { ...standard, ...agentModel }]),
      defaultModel: () => Effect.succeed(standard),
    }
    const session = { id: "one", directory: "project" }
    assert.deepEqual(yield* resolveSourceModel({ ...session, model }, catalog), model)
    assert.deepEqual(yield* resolveSourceModel(session, catalog), agentModel)
    assert.deepEqual(yield* resolveSourceModel({ ...session, agent: "other" }, catalog), { providerID: "test", id: "default" })
    const absentAgent = { ...catalog, models: () => Effect.succeed([standard]) }
    assert.deepEqual(yield* resolveSourceModel(session, absentAgent), { providerID: "test", id: "default" })
    const missing = { ...catalog, agents: () => Effect.succeed([]), models: () => Effect.succeed([]), defaultModel: () => Effect.succeed(undefined) }
    assert.ok(Exit.isFailure(yield* Effect.exit(resolveSourceModel(session, missing))))
  }))
})

test("concurrency and location queue are bounded and overflow/oversized input are visible", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* setup()
    for (let i = 1; i <= CONCURRENCY + MAX_QUEUED + 1; i++) yield* f.teacher.admit(admission(i))
    yield* eventually(() => f.calls.length === CONCURRENCY)
    assert.equal((yield* f.teacher.status("one")).pending, CONCURRENCY + MAX_QUEUED)
    assert.match((yield* f.teacher.status("one")).error!, /queue is full/)
    yield* f.teacher.admit(admission(1000, "two", "x".repeat(MAX_INPUT + 1)))
    assert.match((yield* f.teacher.status("two")).error!, /64,000/)
    assert.equal(f.calls.length, CONCURRENCY)
  })))
})

test("the total deadline includes queued time and interrupts only teacher requests", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* setup(undefined, { concurrency: 1 })
    yield* f.teacher.admit(admission(1))
    yield* f.teacher.admit(admission(2))
    yield* eventually(() => f.calls.length === 1 && f.selections.length === 2)
    yield* TestClock.adjust(DEADLINE_MS)
    yield* settled(f.teacher)
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0].interrupted, true)
    assert.match((yield* f.teacher.status("one")).error!, /timed out/)
    assert.equal((yield* f.teacher.status("one")).count, 0)
  })).pipe(Effect.provide(TestClock.layer())))
})

test("older successes cannot hide a newer resource-limit error", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* setup(undefined, { concurrency: 1, queued: 0 })
    yield* f.teacher.admit(admission(1))
    yield* eventually(() => f.calls.length === 1)
    yield* f.teacher.admit(admission(2))
    yield* Deferred.succeed(f.calls[0].result, clean)
    yield* settled(f.teacher)
    assert.match((yield* f.teacher.status("one")).error!, /queue is full/)
    yield* f.teacher.admit(admission(3))
    yield* eventually(() => f.calls.length === 2)
    yield* Deferred.succeed(f.calls[1].result, clean)
    yield* settled(f.teacher)
    assert.equal((yield* f.teacher.status("one")).error, null)
  })))
})

test("moves, deletion, lost observation and teardown revoke publication authority", async () => {
  for (const action of ["move", "delete", "observation", "stop"] as const) {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = yield* setup()
      yield* f.teacher.admit(admission(1))
      yield* eventually(() => f.calls.length === 1)
      if (action === "move") {
        f.sessions.get("one")!.directory = "elsewhere"
        yield* f.teacher.moved("one")
      } else if (action === "delete") {
        f.sessions.delete("one")
        yield* f.teacher.deleted("one")
      } else if (action === "observation") yield* f.teacher.observationLost
      else yield* f.teacher.stop()
      yield* eventually(() => f.calls[0].interrupted)
      yield* Deferred.succeed(f.calls[0].result, corrected)
      assert.equal((yield* f.store.state("one")).count, 0)
      assert.equal(f.notifications.length, 0)
    })))
  }
})

test("missed moves are checked at commit; missed deletions purge settings and history on access", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* setup()
    yield* f.teacher.admit(admission(1))
    yield* eventually(() => f.calls.length === 1)
    yield* Deferred.succeed(f.calls[0].result, corrected)
    yield* settled(f.teacher)
    yield* f.teacher.setEnabled("one", true)
    yield* f.teacher.admit(admission(2))
    yield* eventually(() => f.calls.length === 2)
    f.sessions.get("one")!.directory = "elsewhere"
    const before = f.changes.length
    yield* Deferred.succeed(f.calls[1].result, corrected)
    yield* eventually(() => f.changes.length > before)
    const other = yield* createTeacher({ ...f.host, directory: "elsewhere" }, f.store, { enabledByDefault: true })
    assert.equal((yield* other.status("one")).count, 1)
    assert.equal((yield* other.status("one")).overridden, true)
    f.sessions.delete("one")
    assert.ok(Exit.isFailure(yield* Effect.exit(other.status("one"))))
    assert.deepEqual(yield* f.store.state("one"), { version: 1, sessionID: "one", count: 0 })
  })))
})

test("disable during storage commit rolls back a delayed result before acknowledging", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const fake = fakeHost()
    const memory = memoryStorage()
    const writing = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const store = createStore({ ...memory.storage, set: (key, value) => key.includes("/comment/")
      ? Deferred.succeed(writing, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(memory.storage.set(key, value)))
      : memory.storage.set(key, value) })
    const teacher = yield* createTeacher(fake.host, store, { enabledByDefault: true })
    yield* teacher.admit(admission(1))
    yield* eventually(() => fake.calls.length === 1)
    yield* Deferred.succeed(fake.calls[0].result, corrected)
    yield* Deferred.await(writing)
    const toggle = yield* teacher.setEnabled("one", false).pipe(Effect.forkScoped)
    yield* Effect.yieldNow
    yield* Deferred.succeed(release, undefined)
    const result = yield* Fiber.join(toggle)
    assert.equal(result.enabled, false)
    assert.equal(result.count, 0)
    assert.equal(fake.notifications.length, 0)
    assert.deepEqual((yield* teacher.list("one")).items, [])
  })))
})

test("a move missed during persistence is rolled back before another location can read it", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* setup()
    f.onSet((key) => { if (key.includes("/comment/")) f.sessions.get("one")!.directory = "elsewhere" })
    yield* f.teacher.admit(admission(1))
    yield* eventually(() => f.calls.length === 1)
    const before = f.changes.length
    yield* Deferred.succeed(f.calls[0].result, corrected)
    yield* eventually(() => f.changes.length > before)
    assert.equal((yield* f.store.state("one")).count, 0)
    assert.equal(f.notifications.length, 0)
  })))
})

test("teardown interrupts a held post-save ownership check and rolls back its unpublished record", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = fakeHost()
    const memory = memoryStorage()
    const store = createStore(memory.storage)
    const atCheck = yield* Deferred.make<void>()
    let reads = 0
    const teacher = yield* createTeacher({ ...f.host, session: (id) => Effect.suspend(() => {
      reads++
      if (reads === 4) return Deferred.succeed(atCheck, undefined).pipe(Effect.andThen(Effect.never))
      return f.host.session(id)
    }) }, store, { enabledByDefault: true })
    yield* teacher.admit(admission(1))
    yield* eventually(() => f.calls.length === 1)
    yield* Deferred.succeed(f.calls[0].result, corrected)
    yield* Deferred.await(atCheck)
    yield* teacher.stop()
    assert.equal((yield* store.state("one")).count, 0)
    assert.equal(f.notifications.length, 0)
  })))
})

test("disable during the first session read cannot start generation after that read is released", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = fakeHost()
    const store = createStore(memoryStorage().storage)
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let first = true
    const teacher = yield* createTeacher({ ...f.host, session: (id) => Effect.suspend(() => {
      if (!first) return f.host.session(id)
      first = false
      return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(f.host.session(id)))
    }) }, store, { enabledByDefault: true })
    yield* teacher.admit(admission(1))
    yield* Deferred.await(entered)
    yield* teacher.setEnabled("one", false)
    yield* Deferred.succeed(release, undefined)
    yield* teacher.setEnabled("one", true)
    yield* settled(teacher)
    assert.equal(f.calls.length, 0)
  })))
})

test("provider and storage errors are sanitized status failures rather than prompt or history failures", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* setup()
    f.onSet((key) => { if (key.includes("/index/")) throw new Error("SECRET_STORAGE") })
    yield* f.teacher.admit(admission(1))
    yield* eventually(() => f.calls.length === 1)
    yield* Deferred.succeed(f.calls[0].result, corrected)
    yield* eventually(() => f.changes.length >= 2)
    f.onSet()
    yield* settled(f.teacher)
    const storedStatus = yield* f.teacher.status("one")
    assert.match(storedStatus.error!, /storage/)
    assert.ok(!storedStatus.error?.includes("SECRET"))
    assert.equal(storedStatus.count, 0)
    const failed = yield* createTeacher({ ...f.host, generate: () => Effect.fail(new Error("SECRET_PROVIDER")) }, f.store,
      { enabledByDefault: true })
    yield* failed.admit(admission(2))
    yield* settled(failed)
    const providerStatus = yield* failed.status("one")
    assert.match(providerStatus.error!, /provider/)
    assert.ok(!providerStatus.error?.includes("SECRET"))
    assert.equal(providerStatus.count, 0)
    assert.equal(f.notifications.length, 0)
  })))
})

test("bounded maintenance removes missed deletions without accessing deleted sessions or losing moved history", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = yield* setup()
    for (let i = 0; i < 30; i++) yield* f.store.setEnabled(`deleted-${i}`, false)
    yield* f.store.setEnabled("foreign", true)
    yield* f.teacher.maintain
    assert.equal([...f.data.keys()].filter((key) => key.startsWith("v1/owners/")).length, 6)
    yield* f.teacher.maintain
    assert.deepEqual([...f.data.keys()].filter((key) => key.startsWith("v1/owners/")), ["v1/owners/foreign"])
    assert.equal((yield* f.store.state("foreign")).enabled, true)
    assert.equal(f.calls.length, 0)
    assert.ok(f.scans.filter((scan) => scan.prefix === "v1/owners/").every((scan) => scan.limit === 25))
  })))
})

test("an enable cannot authorize an earlier disabled admission held in its first snapshot", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = fakeHost()
    const store = createStore(memoryStorage().storage)
    yield* store.setEnabled("one", false)
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let first = true
    const teacher = yield* createTeacher({ ...f.host, session: (id) => Effect.gen(function* () {
      const snapshot = yield* f.host.session(id)
      if (first) {
        first = false
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(release)
      }
      return snapshot
    }) }, store, { enabledByDefault: true })
    yield* teacher.admit(admission(1))
    yield* Deferred.await(entered)
    let acknowledged = false
    const enabling = yield* teacher.setEnabled("one", true).pipe(
      Effect.tap(() => Effect.sync(() => { acknowledged = true })), Effect.forkScoped,
    )
    for (let i = 0; i < 10; i++) yield* Effect.yieldNow
    assert.equal(acknowledged, false, "the admission decision must precede this control")
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(enabling)
    for (let i = 0; i < 10; i++) yield* Effect.yieldNow
    assert.equal(f.calls.length, 0)
  })))
})

test("stop and move revoke toggles already holding an old session snapshot", async () => {
  for (const action of ["stop", "move"] as const) {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const f = fakeHost()
      const store = createStore(memoryStorage().storage)
      yield* store.setEnabled("one", false)
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let hold = true
      const teacher = yield* createTeacher({ ...f.host, session: (id) => Effect.gen(function* () {
        const snapshot = yield* f.host.session(id)
        if (hold) {
          hold = false
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
        }
        return snapshot
      }) }, store, { enabledByDefault: true })
      const toggle = yield* teacher.setEnabled("one", true).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      if (action === "stop") yield* teacher.stop()
      else {
        f.sessions.get("one")!.directory = "elsewhere"
        yield* teacher.moved("one")
      }
      yield* Deferred.succeed(release, undefined)
      assert.ok(Exit.isFailure(yield* Fiber.await(toggle)))
      assert.equal((yield* store.state("one")).enabled, false)
      assert.equal(f.calls.length, 0)
    })))
  }
})

test("failed rollback after the count write cannot resurrect a disabled correction", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = fakeHost()
    const memory = memoryStorage()
    const written = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let hold = true
    let refuseRollbackMarker = false
    const storage = { ...memory.storage, set: (key: string, value: Parameters<typeof memory.storage.set>[1]) => Effect.gen(function* () {
      const state = value && typeof value === "object" && !Array.isArray(value) ? value : {}
      if (refuseRollbackMarker && key.endsWith("/state") && "pending" in state && state.pending && "count" in state && state.count === 0)
        return yield* Effect.die(new Error("rollback marker unavailable"))
      yield* memory.storage.set(key, value)
      if (hold && key.endsWith("/state") && "count" in state && state.count === 1) {
        hold = false
        yield* Deferred.succeed(written, undefined)
        yield* Deferred.await(release)
      }
    }) }
    const store = createStore(storage)
    const teacher = yield* createTeacher(f.host, store, { enabledByDefault: true })
    yield* teacher.admit(admission(1))
    yield* eventually(() => f.calls.length === 1)
    yield* Deferred.succeed(f.calls[0].result, corrected)
    yield* Deferred.await(written)
    const disabling = yield* teacher.setEnabled("one", false).pipe(Effect.forkScoped)
    for (let i = 0; i < 10; i++) yield* Effect.yieldNow
    refuseRollbackMarker = true
    yield* Deferred.succeed(release, undefined)
    const disabled = yield* Fiber.join(disabling)
    assert.equal(disabled.count, 0)
    assert.equal(disabled.enabled, false)
    assert.equal(f.notifications.length, 0)
    const reopened = createStore(storage)
    assert.equal((yield* reopened.state("one")).count, 0)
    assert.deepEqual((yield* reopened.list("one")).items, [])
  })))
})

test("a failed post-save ownership rollback stays unreadable until recoverable cleanup succeeds", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = fakeHost()
    const memory = memoryStorage()
    let cleanupBroken = false
    const storage = {
      ...memory.storage,
      set: (key: string, value: Parameters<typeof memory.storage.set>[1]) => Effect.suspend(() => {
        const state = value && typeof value === "object" && !Array.isArray(value) ? value : {}
        return cleanupBroken && "pending" in state && state.pending ? Effect.die(new Error("rollback marker failed")) : memory.storage.set(key, value)
      }),
      remove: (key: string) => cleanupBroken ? Effect.die(new Error("cleanup failed")) : memory.storage.remove(key),
    }
    let reads = 0
    const store = createStore(storage)
    const teacher = yield* createTeacher({ ...f.host, session: (id) => Effect.gen(function* () {
      reads++
      if (reads === 4) {
        cleanupBroken = true
        f.sessions.get("one")!.directory = "elsewhere"
      }
      return yield* f.host.session(id)
    }) }, store, { enabledByDefault: true })
    yield* teacher.admit(admission(1))
    yield* eventually(() => f.calls.length === 1)
    yield* Deferred.succeed(f.calls[0].result, corrected)
    yield* eventually(() => cleanupBroken && f.changes.length >= 2)
    const reopened = createStore(storage)
    assert.ok(Exit.isFailure(yield* Effect.exit(reopened.list("one"))))
    assert.equal(f.notifications.length, 0)
    cleanupBroken = false
    assert.equal((yield* reopened.state("one")).count, 0)
    assert.deepEqual((yield* reopened.list("one")).items, [])
  })))
})

test("mention gaps cannot become contiguous correction targets", () => {
  const text = prepareText(admittedText({
    text: "This gives @file advices.",
    files: [{ mention: { start: 11, end: 16, text: "@file" } }],
  }))
  assert.equal(text, "This gives [omitted] advices.")
  assert.throws(() => parseCorrections(JSON.stringify({ corrections: [
    { original: "gives   advices", replacement: "gives advice" },
  ] }), text))
  assert.throws(() => parseCorrections(JSON.stringify({ corrections: [
    { original: "gives [omitted] advices", replacement: "gives advice" },
  ] }), text))
})

test("teardown drains a held provisional toggle write and restores the prior override", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const f = fakeHost()
    const memory = memoryStorage()
    yield* createStore(memory.storage).setEnabled("one", false)
    const writing = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let hold = true
    const storage = { ...memory.storage, set: (key: string, value: Parameters<typeof memory.storage.set>[1]) => Effect.gen(function* () {
      yield* memory.storage.set(key, value)
      if (hold && value && typeof value === "object" && "setting" in value) {
        hold = false
        yield* Deferred.succeed(writing, undefined)
        yield* Deferred.await(release)
      }
    }) }
    const store = createStore(storage)
    const teacher = yield* createTeacher(f.host, store, { enabledByDefault: true })
    const toggle = yield* teacher.setEnabled("one", true).pipe(Effect.forkScoped)
    yield* Deferred.await(writing)
    let stopped = false
    const stopping = yield* teacher.stop().pipe(Effect.tap(() => Effect.sync(() => { stopped = true })), Effect.forkScoped)
    for (let i = 0; i < 10; i++) yield* Effect.yieldNow
    assert.equal(stopped, false, "teardown must drain in-flight owned storage writes")
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(stopping)
    assert.ok(Exit.isFailure(yield* Fiber.await(toggle)))
    assert.equal((yield* createStore(storage).state("one")).enabled, false)
    assert.equal(f.calls.length, 0)
  })))
})
