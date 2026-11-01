import type { Plugin } from "@opencode/plugin/effect"
import { Deferred, Effect } from "effect"
import { z } from "zod"
import { CommentSchema, type Comment, type CommentList } from "./contracts.ts"

export type Storage = Plugin.Context["storage"]

const PendingSchema = z.object({ id: z.string(), order: z.number().int().nonnegative().safe() }).strict()
const StateSchema = z.object({
  version: z.literal(1),
  sessionID: z.string(),
  count: z.number().int().nonnegative(),
  enabled: z.boolean().optional(),
  pending: PendingSchema.extend({ count: z.number().int().nonnegative().optional() }).strict().optional(),
  setting: z.object({ previous: z.boolean().optional() }).strict().optional(),
}).strict()
const IndexSchema = PendingSchema
const OwnerSchema = z.object({ sessionID: z.string().min(1) }).strict()
type State = z.infer<typeof StateSchema>

export class StoreError extends Error {
  constructor() { super("English teacher storage is unavailable or contains unsupported data.") }
}

interface Ticket { ready: Deferred.Deferred<void>; released: boolean }
const queues = new Map<string, Ticket[]>()

export function reserveSession(sessionID: string) {
  const queue = queues.get(sessionID) ?? []
  const ticket: Ticket = { ready: Deferred.makeUnsafe<void>(), released: false }
  queues.set(sessionID, queue)
  queue.push(ticket)
  if (queue.length === 1) Deferred.doneUnsafe(ticket.ready, Effect.void)
  const release = () => {
    if (ticket.released) return
    ticket.released = true
    while (queue[0]?.released) queue.shift()
    if (queue.length) Deferred.doneUnsafe(queue[0].ready, Effect.void)
    else queues.delete(sessionID)
  }
  return {
    release,
    run: <A, E, R>(action: Effect.Effect<A, E, R>) => Effect.suspend(() => ticket.released
      ? Effect.interrupt
      : Deferred.await(ticket.ready).pipe(Effect.andThen(action))).pipe(Effect.ensuring(Effect.sync(release))),
  }
}

export function serialized<A, E, R>(sessionID: string, action: Effect.Effect<A, E, R>) {
  return Effect.suspend(() => reserveSession(sessionID).run(action))
}

const prefix = (sessionID: string) => `v1/session/${encodeURIComponent(sessionID)}/`
const stateKey = (sessionID: string) => `${prefix(sessionID)}state`
const recordKey = (sessionID: string, id: string) => `${prefix(sessionID)}comment/${encodeURIComponent(id)}`
const indexPrefix = (sessionID: string) => `${prefix(sessionID)}index/`
const ownerPrefix = "v1/owners/"
const ownerKey = (sessionID: string) => ownerPrefix + encodeURIComponent(sessionID)
const indexKey = (sessionID: string, item: z.infer<typeof IndexSchema>) =>
  `${indexPrefix(sessionID)}${String(Number.MAX_SAFE_INTEGER - item.order).padStart(16, "0")}/${encodeURIComponent(item.id)}`

function checked<A>(action: Effect.Effect<A, unknown>): Effect.Effect<A, StoreError> {
  return action.pipe(Effect.catchCause(() => Effect.fail(new StoreError())))
}

export function createStore(storage: Storage) {
  const state = Effect.fnUntraced(function* (sessionID: string) {
    const raw = yield* storage.get(stateKey(sessionID))
    const value = raw === undefined
      ? { version: 1 as const, sessionID, count: 0 }
      : StateSchema.parse(raw)
    if (value.sessionID !== sessionID) throw new StoreError()
    if (!value.pending && !value.setting) return value
    const { pending, setting, ...clean } = value
    if (pending) {
      yield* storage.remove(indexKey(sessionID, pending))
      yield* storage.remove(recordKey(sessionID, pending.id))
      clean.count = pending.count ?? value.count
    }
    if (setting) {
      if (setting.previous === undefined) delete clean.enabled
      else clean.enabled = setting.previous
    }
    yield* storage.set(stateKey(sessionID), clean)
    return clean
  })

  const get = Effect.fnUntraced(function* (sessionID: string, id: string) {
    const value = yield* storage.get(recordKey(sessionID, id))
    if (value === undefined) return null
    const comment = CommentSchema.parse(value)
    if (comment.id !== id || comment.sessionID !== sessionID) throw new StoreError()
    return comment
  })

  const indexes = Effect.fnUntraced(function* (sessionID: string, after?: string, limit = 50) {
    const p = indexPrefix(sessionID)
    if (after !== undefined && !after.startsWith(p)) throw new StoreError()
    const page = yield* storage.scan({ prefix: p, limit, ...(after === undefined ? {} : { after }) })
    return {
      entries: page.entries.map((entry) => {
        const item = IndexSchema.parse(entry.value)
        if (entry.key !== indexKey(sessionID, item)) throw new StoreError()
        return { key: entry.key, ...item }
      }),
      next: page.next ?? null,
    }
  })

  const list = Effect.fnUntraced(function* (sessionID: string, cursor?: string, limit = 25): Effect.fn.Return<CommentList, StoreError> {
    const current = yield* checked(state(sessionID))
    const page = yield* checked(indexes(sessionID, cursor, limit))
    const items: Comment[] = []
    for (const entry of page.entries) {
      const comment = yield* checked(get(sessionID, entry.id))
      if (!comment) return yield* Effect.fail(new StoreError())
      items.push(comment)
    }
    return { items, next: page.next, total: current.count }
  })

  const view = Effect.fnUntraced(function* (sessionID: string, id?: string, direction?: "older" | "newer") {
    const current = yield* state(sessionID)
    let cursor: string | undefined
    let previous: { id: string; position: number } | undefined
    let selected: { id: string; position: number } | undefined
    let position = 0
    let seekOlder = false
    do {
      const page = yield* indexes(sessionID, cursor, id === undefined ? 1 : 100)
      for (const entry of page.entries) {
        position++
        if (id === undefined || seekOlder) {
          selected = { id: entry.id, position }
          break
        }
        if (entry.id === id) {
          selected = { id: entry.id, position }
          if (direction === "newer" && previous) selected = previous
          if (direction !== "older") break
          seekOlder = true
        }
        previous = { id: entry.id, position }
      }
      if (selected && (!seekOlder || selected.id !== id)) break
      cursor = page.next ?? undefined
    } while (cursor !== undefined)
    if (id !== undefined && !selected) throw new StoreError()
    const comment = selected ? yield* get(sessionID, selected.id) : null
    if (selected && !comment) throw new StoreError()
    return { comment, position: selected?.position ?? 0, total: current.count }
  })

  const prepareEnabled = Effect.fnUntraced(function* (sessionID: string, enabled: boolean, valid: () => boolean) {
    const current = yield* state(sessionID)
    if (!valid()) return null
    yield* storage.set(ownerKey(sessionID), { sessionID })
    if (!valid()) return null
    const prepared: State = { ...current, enabled, setting: current.enabled === undefined ? {} : { previous: current.enabled } }
    yield* storage.set(stateKey(sessionID), prepared)
    if (!valid()) {
      yield* state(sessionID)
      return null
    }
    return prepared
  })

  const prepare = Effect.fnUntraced(function* (comment: Comment, order: number, valid: () => boolean) {
    CommentSchema.parse(comment)
    const index = PendingSchema.parse({ id: comment.id, order })
    const current = yield* state(comment.sessionID)
    if ((yield* get(comment.sessionID, comment.id)) || !valid()) return null
    const pending = { ...index, count: current.count }
    const key = indexKey(comment.sessionID, index)
    yield* storage.set(ownerKey(comment.sessionID), { sessionID: comment.sessionID })
    if (!valid()) return null
    yield* storage.set(stateKey(comment.sessionID), { ...current, pending })
    if (valid()) yield* storage.set(recordKey(comment.sessionID, comment.id), comment)
    if (valid()) yield* storage.set(key, index)
    const prepared: State = { ...current, count: current.count + 1, pending }
    if (valid()) yield* storage.set(stateKey(comment.sessionID), prepared)
    if (!valid()) {
      yield* state(comment.sessionID)
      return null
    }
    return prepared
  })

  const commit = Effect.fnUntraced(function* (prepared: State) {
    StateSchema.parse(prepared)
    if (!prepared.pending && !prepared.setting) throw new StoreError()
    const { pending: _, setting: __, ...committed } = prepared
    yield* storage.set(stateKey(prepared.sessionID), committed)
  })

  const save = Effect.fnUntraced(function* (comment: Comment, order: number, valid: () => boolean) {
    const prepared = yield* prepare(comment, order, valid)
    if (!prepared) return false
    yield* commit(prepared)
    return true
  })

  const setEnabled = Effect.fnUntraced(function* (sessionID: string, enabled: boolean) {
    const prepared = yield* prepareEnabled(sessionID, enabled, () => true)
    if (prepared) yield* commit(prepared)
  })

  const purge = Effect.fnUntraced(function* (sessionID: string) {
    let after: string | undefined
    do {
      const page = yield* storage.scan({ prefix: prefix(sessionID), limit: 100, ...(after ? { after } : {}) })
      for (const entry of page.entries) yield* storage.remove(entry.key)
      after = page.next
    } while (after !== undefined)
    yield* storage.remove(ownerKey(sessionID))
  })

  const owners = Effect.fnUntraced(function* (after?: string) {
    const page = yield* storage.scan({ prefix: ownerPrefix, limit: 25, ...(after ? { after } : {}) })
    return {
      ids: page.entries.map((entry) => {
        const value = OwnerSchema.parse(entry.value)
        if (entry.key !== ownerKey(value.sessionID)) throw new StoreError()
        return value.sessionID
      }),
      next: page.next,
    }
  })

  return {
    state: (sessionID: string) => checked(state(sessionID)).pipe(Effect.uninterruptible),
    list,
    view: (sessionID: string, id?: string, direction?: "older" | "newer") => checked(view(sessionID, id, direction)),
    setEnabled: (sessionID: string, enabled: boolean) => checked(setEnabled(sessionID, enabled)).pipe(Effect.uninterruptible),
    save: (comment: Comment, order: number, valid: () => boolean) => checked(save(comment, order, valid)).pipe(Effect.uninterruptible),
    prepare: (comment: Comment, order: number, valid: () => boolean) => checked(prepare(comment, order, valid)).pipe(Effect.uninterruptible),
    prepareEnabled: (sessionID: string, enabled: boolean, valid: () => boolean) => checked(prepareEnabled(sessionID, enabled, valid)).pipe(Effect.uninterruptible),
    commit: (prepared: State) => checked(commit(prepared)).pipe(Effect.uninterruptible),
    rollback: (sessionID: string) => checked(state(sessionID)).pipe(Effect.asVoid, Effect.uninterruptible),
    purge: (sessionID: string) => checked(purge(sessionID)).pipe(Effect.uninterruptible),
    owners: (after?: string) => checked(owners(after)),
  }
}

export type Store = ReturnType<typeof createStore>
export type SessionState = State
