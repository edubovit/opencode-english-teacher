import { Model, Plugin, Provider } from "@opencode/plugin/effect"
import { Brand, Cause, Effect, Stream } from "effect"
import { z } from "zod"
import { parseOptions, ConfigError, type Options } from "./config.ts"
import { PLUGIN_ID, type ModelRef } from "./contracts.ts"
import { EnglishTeacher } from "./rpc.ts"
import { createTeacher, MAX_INPUT, ModelUnavailable, Unavailable, type Admission, type SessionSnapshot, type TeacherHost } from "./service.ts"
import { createStore, StoreError } from "./storage.ts"
import { readTeacherPrompt, PromptFileError } from "./prompt-file.ts"

interface AgentSelection {
  id: string
  hidden?: boolean
  mode?: string
  model?: ModelRef
}

interface CatalogModel extends ModelRef {
  package?: string
  capabilities: { input: readonly string[]; output: readonly string[] }
}

export interface Catalog {
  agents: () => Effect.Effect<readonly AgentSelection[], unknown>
  models: () => Effect.Effect<readonly CatalogModel[], unknown>
  defaultModel: () => Effect.Effect<CatalogModel | undefined, unknown>
}

export const resolveSourceModel = Effect.fnUntraced(function* (session: SessionSnapshot, catalog: Catalog) {
  if (session.model) return { ...session.model }
  const agents = yield* catalog.agents()
  const agent = session.agent
    ? agents.find((agent) => agent.id === session.agent)
    : agents.find((agent) => !agent.hidden && agent.mode !== "subagent")
  if (agent?.model) {
    const available = yield* catalog.models()
    if (available.some((model) => model.providerID === agent.model?.providerID && model.id === agent.model.id))
      return { ...agent.model }
  }
  const selected = yield* catalog.defaultModel()
  if (selected?.package) return { providerID: selected.providerID, id: selected.id }
  const available = yield* catalog.models()
  const fallback = available.find((model) => model.package && [model.capabilities.input, model.capabilities.output]
    .every((types) => types.length === 0 || types.some((type) => type.startsWith("text"))))
  if (!fallback) return yield* Effect.fail(new ModelUnavailable())
  return { providerID: fallback.providerID, id: fallback.id }
})

interface Mention { start: number; end: number; text: string }
interface TextPayload {
  text: string
  files?: readonly { mention?: Mention }[]
  agents?: readonly { mention?: Mention }[]
  skills?: readonly { mention?: Mention }[]
}

export function admittedText(payload: TextPayload): string {
  const ranges = [...payload.files ?? [], ...payload.agents ?? [], ...payload.skills ?? []]
    .flatMap((item) => item.mention ? [item.mention] : [])
    .filter((range) => Number.isInteger(range.start) && Number.isInteger(range.end) && range.start >= 0 &&
      range.end > range.start && range.end <= payload.text.length && payload.text.slice(range.start, range.end) === range.text)
    .sort((a, b) => a.start - b.start)
  let result = ""
  let end = 0
  for (const range of ranges) {
    result += payload.text.slice(end, Math.max(end, range.start))
    result += "[omitted]"
    end = Math.max(end, range.end)
  }
  return result + payload.text.slice(end)
}

const MentionSchema = z.object({ mention: z.object({ start: z.number(), end: z.number(), text: z.string() }).optional() })
const AdmissionEventSchema = z.object({
  type: z.literal("session.inbox.enqueued"),
  created: z.number().finite(),
  location: z.object({ directory: z.string(), workspaceID: z.string().optional() }),
  durable: z.object({ seq: z.number().int().nonnegative().safe() }),
  data: z.object({
    sessionID: z.string().min(1).max(200),
    inboxID: z.string().min(1).max(200),
    item: z.object({
      type: z.literal("user"),
      payload: z.object({
        text: z.string(),
        files: z.array(MentionSchema).optional(),
        agents: z.array(MentionSchema).optional(),
        skills: z.array(MentionSchema).optional(),
      }),
    }),
  }),
})

export function admissionFromEvent(raw: unknown, directory: string, workspaceID?: string): Admission | undefined {
  const parsed = AdmissionEventSchema.safeParse(raw)
  if (!parsed.success || parsed.data.location.directory !== directory || parsed.data.location.workspaceID !== workspaceID) return
  const event = parsed.data
  const payload = event.data.item.payload
  return {
    sessionID: event.data.sessionID,
    id: event.data.inboxID,
    order: event.durable.seq,
    sourceTime: event.created,
    directory,
    ...(workspaceID === undefined ? {} : { workspaceID }),
    text: payload.text.length > MAX_INPUT ? "" : admittedText(payload),
    sourceLength: payload.text.length,
  }
}

const sessionID = Brand.nominal<Parameters<Plugin.Context["session"]["get"]>[0]["sessionID"]>()
const missingSession = z.object({ _tag: z.literal("Session.NotFoundError") })

function hostModel(model: ModelRef): Model.Ref {
  return Model.Ref.make({
    providerID: Provider.ID.make(model.providerID),
    id: Model.ID.make(model.id),
    ...(model.variant === undefined ? {} : { variant: Model.VariantID.make(model.variant) }),
  })
}

export function makeHost(ctx: Plugin.Context): Omit<TeacherHost, "changed" | "corrected"> {
  const location = { directory: ctx.location.directory }
  const catalog: Catalog = {
    agents: () => ctx.agent.list({ location }).pipe(Effect.map((result) => result.data)),
    models: () => ctx.model.list({ location }).pipe(Effect.map((result) => result.data)),
    defaultModel: () => ctx.model.default({ location }).pipe(Effect.map((result) => result.data)),
  }
  return {
    directory: ctx.location.directory,
    ...(ctx.location.workspaceID === undefined ? {} : { workspaceID: ctx.location.workspaceID }),
    session: (id) => ctx.session.get({ sessionID: sessionID(id) }).pipe(
      Effect.map((session): SessionSnapshot | null => ({
        id: session.id,
        directory: session.location.directory,
        ...(session.location.workspaceID === undefined ? {} : { workspaceID: session.location.workspaceID }),
        ...(session.parentID ? { parentID: session.parentID } : {}),
        ...(session.title ? { title: session.title } : {}),
        ...(session.agent ? { agent: session.agent } : {}),
        ...(session.model ? { model: { ...session.model } } : {}),
      })),
      Effect.catch((error) => missingSession.safeParse(error).success ? Effect.succeed(null) : Effect.fail(error)),
    ),
    sourceModel: (session) => resolveSourceModel(session, catalog),
    instructions: () => Effect.tryPromise({ try: () => readTeacherPrompt(), catch: () => new PromptFileError() }),
    generate: (prompt, model) => ctx.experimental.generate.text({ prompt, model: hostModel(model) })
      .pipe(Effect.map((result) => result.text)),
  }
}

export default Plugin.define({
  id: PLUGIN_ID,
  effect: (ctx) => Effect.gen(function* () {
    yield* Effect.tryPromise({ try: () => readTeacherPrompt(), catch: () => new PromptFileError() })
      .pipe(Effect.catch((error) => Effect.logWarning(error.message)))
    let options: Options | null = null
    let configError: string | null = null
    try {
      options = parseOptions(ctx.options)
    } catch (error) {
      configError = error instanceof ConfigError ? error.message : "Invalid English teacher options."
    }
    let emitChanged: TeacherHost["changed"] = () => Effect.void
    let emitCorrected: TeacherHost["corrected"] = () => Effect.void
    const teacher = yield* createTeacher({
      ...makeHost(ctx),
      changed: (id) => emitChanged(id),
      corrected: (id, commentID, title) => emitCorrected(id, commentID, title),
    }, createStore(ctx.storage), options, configError)
    const rpc = yield* ctx.rpc.register(EnglishTeacher, {
      status: ({ sessionID }, call) => teacher.status(sessionID).pipe(Effect.catchCause((cause) =>
        Effect.fail(call.error("unavailable", unavailableMessage(cause), null)))),
      view: ({ sessionID, id, direction }, call) => teacher.view(sessionID, id, direction).pipe(Effect.catchCause((cause) =>
        Effect.fail(call.error("unavailable", unavailableMessage(cause), null)))),
      list: ({ sessionID, cursor, limit }, call) => teacher.list(sessionID, cursor, limit).pipe(Effect.catchCause((cause) =>
        Effect.fail(call.error("unavailable", unavailableMessage(cause), null)))),
      setEnabled: ({ sessionID, enabled }, call) => teacher.setEnabled(sessionID, enabled).pipe(Effect.catchCause((cause) =>
        Effect.fail(call.error("unavailable", unavailableMessage(cause), null)))),
    })
    emitChanged = (sessionID) => rpc.events.emit("changed", { sessionID })
    emitCorrected = (sessionID, commentID, sessionTitle) => rpc.events.emit("corrected", { sessionID, commentID, sessionTitle })
    yield* ctx.event.subscribe({ types: ["session.inbox.enqueued", "session.deleted", "session.moved"] }).pipe(
      Stream.runForEach((event) => {
        if (event.type === "session.moved") return teacher.moved(event.data.sessionID)
        if (event.type === "session.deleted") return teacher.deleted(event.data.sessionID).pipe(
          Effect.catchCause(() => Effect.void),
        )
        const admission = admissionFromEvent(event, ctx.location.directory, ctx.location.workspaceID)
        return admission ? teacher.admit(admission) : Effect.void
      }),
      Effect.andThen(teacher.observationLost),
      Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause) ? Effect.void : teacher.observationLost),
      Effect.forkScoped,
    )
    yield* Effect.gen(function* () {
      while (true) {
        yield* teacher.maintain.pipe(Effect.catchCause(() => Effect.void))
        yield* Effect.sleep("1 minute")
      }
    }).pipe(Effect.forkScoped)
    yield* Effect.addFinalizer(teacher.stop)
  }).pipe(Effect.catchCause(() => Effect.logWarning("English teacher could not register its server interface."))),
})

function unavailableMessage(cause: Cause.Cause<unknown>) {
  const error = Cause.squash(cause)
  return error instanceof Unavailable || error instanceof StoreError
    ? error.message
    : "English teacher is unavailable. Check session location and plugin storage."
}
