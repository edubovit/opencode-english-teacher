import { Cause, Clock, Effect, Exit, Fiber, Scope, Semaphore } from "effect"
import { AnalysisError, makePrompt, parseCorrections, prepareText, previewText } from "./analysis.ts"
import { selectModel, type Options } from "./config.ts"
import { PROTOCOL_VERSION, type ModelRef, type Status } from "./contracts.ts"
import { reserveSession, serialized, StoreError, type SessionState, type Store } from "./storage.ts"
import { PromptFileError } from "./prompt-file.ts"

export const CONCURRENCY = 2
export const MAX_QUEUED = 100
export const DEADLINE_MS = 120_000
export const MAX_INPUT = 64_000

export interface SessionSnapshot {
  id: string
  directory: string
  workspaceID?: string
  title?: string
  parentID?: string
  agent?: string
  model?: ModelRef
}

export interface Admission {
  sessionID: string
  id: string
  order: number
  sourceTime: number
  text: string
  sourceLength?: number
  directory: string
  workspaceID?: string
}

export interface TeacherHost {
  directory: string
  workspaceID?: string
  session: (id: string) => Effect.Effect<SessionSnapshot | null, unknown>
  sourceModel: (session: SessionSnapshot) => Effect.Effect<ModelRef, unknown>
  instructions: () => Effect.Effect<string, unknown>
  generate: (prompt: string, model: ModelRef) => Effect.Effect<string, unknown>
  changed: (sessionID: string) => Effect.Effect<void, unknown>
  corrected: (sessionID: string, commentID: string, sessionTitle: string) => Effect.Effect<void, unknown>
}

export class Unavailable extends Error {
  constructor(message = "English teacher is unavailable for this session.") { super(message) }
}

export class ModelUnavailable extends Error {
  constructor() { super("The selected model or variant is unavailable. Check the session and plugin model settings.") }
}

interface Job {
  admission: Admission
  deadline: number
  valid: boolean
  epoch: number
  settled: boolean
  decision: ReturnType<typeof reserveSession>
  fiber?: Fiber.Fiber<void, never>
}

interface Control {
  sessionID: string
  epoch: number
  valid: boolean
  settled: boolean
  fiber?: Fiber.Fiber<Status, unknown>
}

interface Limits {
  concurrency?: number
  queued?: number
  deadline?: number
  now?: () => number
}

export const createTeacher = Effect.fnUntraced(function* (
  host: TeacherHost,
  store: Store,
  options: Options | null,
  configError: string | null = null,
  limits: Limits = {},
) {
  const scope = yield* Scope.make("parallel")
  const clock = yield* Clock.Clock
  const concurrency = limits.concurrency ?? CONCURRENCY
  const queued = limits.queued ?? MAX_QUEUED
  const deadline = limits.deadline ?? DEADLINE_MS
  const now = limits.now ?? (() => clock.currentTimeMillisUnsafe())
  const permits = Semaphore.makeUnsafe(concurrency)
  const jobs = new Set<Job>()
  const controls = new Set<Control>()
  const epochs = new Map<string, number>()
  const seen = new Map<string, Set<string>>()
  const errors = new Map<string, { order: number; message: string }>()
  let active = true
  let observationError: string | null = null
  let maintenanceCursor: string | undefined

  const changed = (id: string) => host.changed(id).pipe(Effect.catchCause(() => Effect.void))
  const sameLocation = (location: { directory: string; workspaceID?: string }) =>
    location.directory === host.directory && location.workspaceID === host.workspaceID
  const epoch = (id: string) => epochs.get(id) ?? 0
  const authorized = (id: string, captured: number) => active && epoch(id) === captured
  const live = (job: Job) => authorized(job.admission.sessionID, job.epoch) && job.valid && now() < job.deadline
  const controlLive = (control: Control) => authorized(control.sessionID, control.epoch) && control.valid && !observationError
  const pending = (id: string) => [...jobs].filter((job) => job.valid && !job.settled && job.admission.sessionID === id).length
  const setError = (admission: Admission, message: string) => {
    if ((errors.get(admission.sessionID)?.order ?? -1) <= admission.order)
      errors.set(admission.sessionID, { order: admission.order, message })
  }
  const clearError = (admission: Admission) => {
    if ((errors.get(admission.sessionID)?.order ?? -1) <= admission.order) errors.delete(admission.sessionID)
  }

  const revoke = (sessionID?: string, ownership = false) => {
    if (ownership && sessionID !== undefined) epochs.set(sessionID, epoch(sessionID) + 1)
    const fibers: Fiber.Fiber<unknown, unknown>[] = []
    for (const job of jobs) {
      if (sessionID !== undefined && job.admission.sessionID !== sessionID) continue
      if (job.settled) continue
      job.valid = false
      if (job.fiber) fibers.push(job.fiber)
    }
    if (ownership) for (const control of controls) {
      if (sessionID !== undefined && control.sessionID !== sessionID) continue
      if (control.settled) continue
      control.valid = false
      if (control.fiber) fibers.push(control.fiber)
    }
    return fibers
  }

  const interrupt = (fibers: Fiber.Fiber<unknown, unknown>[]) =>
    fibers.length ? Fiber.interruptAll(fibers).pipe(Effect.forkIn(scope), Effect.asVoid) : Effect.void

  const owned = Effect.fnUntraced(function* (id: string, captured: number) {
    if (!authorized(id, captured)) return yield* Effect.fail(new Unavailable())
    const session = yield* host.session(id)
    if (!authorized(id, captured)) return yield* Effect.fail(new Unavailable())
    if (!session) {
      yield* interrupt(revoke(id, true))
      yield* store.purge(id)
      return yield* Effect.fail(new Unavailable("The source session was deleted."))
    }
    if (!sameLocation(session)) {
      yield* interrupt(revoke(id, true))
      return yield* Effect.fail(new Unavailable("The session moved. Reopen English teacher at its current location."))
    }
    return session
  })

  const statusInside = Effect.fnUntraced(function* (session: SessionSnapshot): Effect.fn.Return<Status, StoreError> {
    const state = yield* store.state(session.id)
    const eligible = !session.parentID
    return {
      protocol: PROTOCOL_VERSION,
      sessionID: session.id,
      enabled: eligible && options !== null && observationError === null && (state.enabled ?? options.enabledByDefault),
      eligible,
      overridden: state.enabled !== undefined,
      pending: pending(session.id),
      count: state.count,
      error: configError ?? observationError ?? errors.get(session.id)?.message ?? null,
    }
  })

  const withSession = <A>(id: string, action: (session: SessionSnapshot) => Effect.Effect<A, unknown>) =>
    Effect.suspend(() => serialized(id, owned(id, epoch(id)).pipe(Effect.flatMap(action))))

  const failJob = Effect.fnUntraced(function* (job: Job, error: unknown) {
    if (!active || !job.valid) return
    if (job.settled && Cause.isTimeoutError(error)) return
    const message = Cause.isTimeoutError(error) || now() >= job.deadline
      ? "English analysis timed out. Future messages will still be checked."
      : error instanceof StoreError || error instanceof AnalysisError || error instanceof ModelUnavailable || error instanceof PromptFileError
        ? error.message
        : "English analysis failed. Check model availability, credentials, and provider status."
    if (!(error instanceof Unavailable)) setError(job.admission, message)
    yield* changed(job.admission.sessionID)
  })

  const rejectAdmission = Effect.fnUntraced(function* (admission: Admission, message: string) {
    yield* withSession(admission.sessionID, (session) => Effect.gen(function* () {
      const status = yield* statusInside(session)
      if (!status.enabled) return
      setError(admission, message)
      yield* changed(admission.sessionID)
    })).pipe(Effect.catchCause(() => Effect.void))
  })

  const run = Effect.fnUntraced(function* (job: Job) {
    const { admission } = job
    const decision = yield* job.decision.run(Effect.gen(function* () {
      const snapshot = yield* owned(admission.sessionID, job.epoch)
      if (!live(job) || snapshot.parentID) return null
      const state = yield* store.state(admission.sessionID)
      if (!live(job) || !options || !(state.enabled ?? options.enabledByDefault)) return null
      const text = prepareText(admission.text)
      if (!text) return null
      const source = options.model ? undefined : yield* host.sourceModel(snapshot)
      if (!live(job)) return null
      return { text, model: selectModel(options, source) }
    }))
    if (!decision || !live(job) || !options) return
    const { text, model } = decision
    yield* permits.withPermit(Effect.gen(function* () {
      if (!live(job)) return
      const current = yield* withSession(admission.sessionID, Effect.succeed)
      if (current.parentID || !live(job)) return
      const instructions = yield* host.instructions()
      if (!live(job)) return
      const output = yield* host.generate(makePrompt(text, instructions), model)
      if (!live(job)) return
      const corrections = parseCorrections(output, text)
      yield* withSession(admission.sessionID, (session) => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        const state = yield* store.state(admission.sessionID)
        if (!live(job) || session.parentID || !(state.enabled ?? options.enabledByDefault)) return
        if (corrections.length === 0) {
          clearError(admission)
          return
        }
        let prepared: SessionState | null = null
        yield* Effect.gen(function* () {
          prepared = yield* store.prepare({
            id: admission.id,
            sessionID: admission.sessionID,
            preview: previewText(text),
            sourceTime: admission.sourceTime,
            completedAt: now(),
            model,
            corrections,
          }, admission.order, () => live(job))
          if (!prepared || !live(job)) return
          const after = yield* restore(owned(admission.sessionID, job.epoch))
          if (!live(job) || after.parentID) return
          job.settled = true
          yield* store.commit(prepared)
          clearError(admission)
          if (authorized(admission.sessionID, job.epoch) && !observationError)
            yield* host.corrected(admission.sessionID, admission.id, after.title || "Untitled session")
        }).pipe(Effect.ensuring(Effect.suspend(() => prepared && !job.settled
          ? store.rollback(admission.sessionID).pipe(Effect.orDie)
          : Effect.void)))
      })))
    }))
  })

  const admit = Effect.fnUntraced(function* (admission: Admission) {
    if (!active || !options || observationError || !sameLocation(admission)) return
    let admissions = seen.get(admission.sessionID)
    if (!admissions) {
      admissions = new Set()
      seen.set(admission.sessionID, admissions)
    }
    if (admissions.has(admission.id)) return
    admissions.add(admission.id)
    if ((admission.sourceLength ?? admission.text.length) > MAX_INPUT) {
      yield* rejectAdmission(admission, `English analysis skipped: the message exceeds ${MAX_INPUT.toLocaleString("en-US")} characters.`)
      return
    }
    if (jobs.size >= concurrency + queued) {
      yield* rejectAdmission(admission, "English analysis queue is full. This message was not checked.")
      return
    }
    const job: Job = {
      admission, deadline: now() + deadline, valid: true, epoch: epoch(admission.sessionID), settled: false,
      decision: reserveSession(admission.sessionID),
    }
    jobs.add(job)
    job.fiber = yield* run(job).pipe(
      Effect.timeout(deadline),
      Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause) ? Effect.void : failJob(job, Cause.squash(cause))),
      Effect.ensuring(Effect.gen(function* () {
        if (active && job.valid && !job.settled && now() >= job.deadline)
          setError(admission, "English analysis timed out. Future messages will still be checked.")
        job.valid = false
        job.decision.release()
        jobs.delete(job)
        if (active) yield* changed(admission.sessionID)
      })),
      Effect.forkIn(scope, { startImmediately: true, uninterruptible: false }),
    )
    yield* changed(admission.sessionID)
  })

  const setEnabled = Effect.fnUntraced(function* (sessionID: string, enabled: boolean) {
    return yield* Effect.uninterruptibleMask((restoreCaller) => Effect.gen(function* () {
      if (!active) return yield* Effect.fail(new Unavailable())
      const control: Control = { sessionID, epoch: epoch(sessionID), valid: true, settled: false }
      const reservation = reserveSession(sessionID)
      controls.add(control)
      const interrupted = enabled ? [] : revoke(sessionID)
      const work = reservation.run(Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        const session = yield* restore(owned(sessionID, control.epoch))
        if (!controlLive(control)) return yield* Effect.fail(new Unavailable())
        if (session.parentID) return yield* Effect.fail(new Unavailable("English analysis is unavailable in child sessions."))
        if (!options || observationError) return yield* Effect.fail(new Unavailable(configError ?? observationError ?? undefined))
        let prepared: SessionState | null = null
        return yield* Effect.gen(function* () {
          prepared = yield* store.prepareEnabled(sessionID, enabled, () => controlLive(control))
          if (!prepared || !controlLive(control)) return yield* Effect.fail(new Unavailable())
          const current = yield* restore(owned(sessionID, control.epoch))
          if (!controlLive(control) || current.parentID) return yield* Effect.fail(new Unavailable())
          control.settled = true
          yield* store.commit(prepared)
          if (!controlLive(control)) return yield* Effect.fail(new Unavailable())
          yield* changed(sessionID)
          const status = yield* statusInside(current)
          if (!controlLive(control)) return yield* Effect.fail(new Unavailable())
          return status
        }).pipe(Effect.ensuring(Effect.suspend(() => prepared && !control.settled
          ? store.rollback(sessionID).pipe(Effect.orDie)
          : Effect.void)))
      }))).pipe(Effect.ensuring(Effect.sync(() => {
        controls.delete(control)
        reservation.release()
      })))
      control.fiber = yield* work.pipe(Effect.forkIn(scope, { startImmediately: true, uninterruptible: false }))
      yield* interrupt(interrupted)
      return yield* restoreCaller(Fiber.join(control.fiber)).pipe(
        Effect.onInterrupt(() => Fiber.interrupt(control.fiber!)),
        Effect.ensuring(Effect.sync(() => {
          controls.delete(control)
          reservation.release()
        })),
      )
    }))
  })

  const deleted = Effect.fnUntraced(function* (sessionID: string) {
    yield* interrupt(revoke(sessionID, true))
    yield* serialized(sessionID, store.purge(sessionID))
    seen.delete(sessionID)
    errors.delete(sessionID)
  })

  const moved = Effect.fnUntraced(function* (sessionID: string) {
    yield* interrupt(revoke(sessionID, true))
    yield* changed(sessionID)
  })

  const stop = Effect.fnUntraced(function* () {
    active = false
    revoke(undefined, true)
    yield* Scope.close(scope, Exit.void)
  })
  yield* Effect.addFinalizer(stop)

  return {
    admit,
    deleted,
    moved,
    stop,
    maintain: Effect.gen(function* () {
      if (!active) return
      const page = yield* store.owners(maintenanceCursor)
      for (const id of page.ids) {
        yield* serialized(id, Effect.gen(function* () {
          if (!active || (yield* host.session(id))) return
          yield* interrupt(revoke(id, true))
          yield* store.purge(id)
          seen.delete(id)
          errors.delete(id)
        })).pipe(Effect.catchCause(() => Effect.void))
      }
      maintenanceCursor = page.next
    }),
    observationLost: Effect.gen(function* () {
      observationError = "English analysis is suspended because event observation stopped. Reload the plugin."
      const affected = [...new Set([...jobs].map((job) => job.admission.sessionID))]
      yield* interrupt(revoke(undefined, true))
      for (const id of affected) yield* changed(id)
    }),
    status: (id: string) => withSession(id, statusInside),
    view: (id: string, commentID?: string, direction?: "older" | "newer") => withSession(id, (session) => Effect.gen(function* () {
      const status = yield* statusInside(session)
      const view = yield* store.view(id, commentID, direction)
      return { ...view, status }
    })),
    list: (id: string, cursor?: string, limit?: number) => withSession(id, () => store.list(id, cursor, limit)),
    setEnabled,
  }
})

export type Teacher = Effect.Success<ReturnType<typeof createTeacher>>
