import assert from "node:assert/strict"
import { Deferred, Effect, type Schema } from "effect"
import type { ModelRef } from "../src/contracts.ts"
import type { Admission, SessionSnapshot, Teacher, TeacherHost } from "../src/service.ts"
import type { Storage } from "../src/storage.ts"
import { DEFAULT_TEACHER_PROMPT } from "../src/analysis.ts"

export function memoryStorage() {
  const data = new Map<string, Schema.Json>()
  const reads: string[] = []
  const scans: { prefix: string; limit?: number }[] = []
  let beforeSet: ((key: string, value: Schema.Json) => void) | undefined
  const storage: Storage = {
    get: (key) => Effect.sync(() => {
      reads.push(key)
      return structuredClone(data.get(key))
    }),
    set: (key, value) => Effect.sync(() => {
      beforeSet?.(key, value)
      data.set(key, structuredClone(value))
    }),
    remove: (key) => Effect.sync(() => { data.delete(key) }),
    scan: ({ prefix, after, limit = 100 }) => Effect.sync(() => {
      scans.push({ prefix, limit })
      const keys = [...data.keys()].filter((key) => key.startsWith(prefix) && (!after || key > after)).sort()
      const page = keys.slice(0, limit)
      return {
        entries: page.map((key) => ({ key, value: structuredClone(data.get(key)!) })),
        ...(keys.length > limit ? { next: page.at(-1)! } : {}),
      }
    }),
  }
  return { storage, data, reads, scans, onSet: (callback?: typeof beforeSet) => { beforeSet = callback } }
}

export const model = { providerID: "test", id: "teacher", variant: "low" }
export const corrected = JSON.stringify({ corrections: [{ original: "gives advices", replacement: "gives advice" }] })
export const clean = JSON.stringify({ corrections: [] })

export function admission(order = 1, sessionID = "one", text = "This gives advices."): Admission {
  return { sessionID, id: `message-${order}`, order, sourceTime: order * 1000, text, directory: "project" }
}

export function fakeHost() {
  const sessions = new Map<string, SessionSnapshot>([
    ["one", { id: "one", directory: "project", title: "Source session", model }],
    ["two", { id: "two", directory: "project", title: "Other session", model }],
    ["child", { id: "child", directory: "project", parentID: "one", model }],
    ["foreign", { id: "foreign", directory: "elsewhere", model }],
  ])
  const calls: { prompt: string; model: ModelRef; result: Deferred.Deferred<string>; interrupted: boolean }[] = []
  const notifications: { sessionID: string; commentID: string; sessionTitle: string }[] = []
  const selections: ModelRef[] = []
  const changes: string[] = []
  const host: TeacherHost = {
    directory: "project",
    instructions: () => Effect.succeed(DEFAULT_TEACHER_PROMPT),
    session: (id) => Effect.sync(() => structuredClone(sessions.get(id) ?? null)),
    sourceModel: (session) => Effect.sync(() => {
      const selected = session.model ?? model
      selections.push(selected)
      return selected
    }),
    generate: (prompt, selected) => Effect.gen(function* () {
      const result = yield* Deferred.make<string>()
      const call = { prompt, model: selected, result, interrupted: false }
      calls.push(call)
      return yield* Deferred.await(result).pipe(Effect.onInterrupt(() => Effect.sync(() => { call.interrupted = true })))
    }),
    changed: (sessionID) => Effect.sync(() => { changes.push(sessionID) }),
    corrected: (sessionID, commentID, sessionTitle) => Effect.sync(() => { notifications.push({ sessionID, commentID, sessionTitle }) }),
  }
  return { host, sessions, calls, notifications, changes, selections }
}

export const eventually = Effect.fnUntraced(function* (condition: () => boolean) {
  for (let attempt = 0; attempt < 2000; attempt++) {
    if (condition()) return
    yield* Effect.yieldNow
  }
  assert.fail("Expected deterministic fiber progress")
})

export const settled = Effect.fnUntraced(function* (teacher: Teacher, sessionID = "one") {
  for (let attempt = 0; attempt < 2000; attempt++) {
    if ((yield* teacher.status(sessionID)).pending === 0) return
    yield* Effect.yieldNow
  }
  assert.fail("Expected teacher jobs to settle")
})
