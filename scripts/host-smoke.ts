import assert from "node:assert/strict"
import { readFile, writeFile, unlink } from "node:fs/promises"
import { join } from "node:path"
import { DEFAULT_TEACHER_PROMPT } from "../src/analysis.ts"
import { fixture, png, providerID } from "./host-fixture.ts"
import type { Correction, ModelRef } from "../src/contracts.ts"
import { isSessionNotFoundError, type SessionPromptInput } from "@opencode/client"

const args = process.argv.slice(2)
assert.ok(args.every(arg => ["--pack", "--tui"].includes(arg) || !arg.startsWith("--")), "Usage: host-smoke.ts [--pack] [--tui] [pluginDirectory]")
const paths = args.filter(arg => !arg.startsWith("--"))
assert.ok(paths.length <= 1, "Only one plugin directory may be supplied")
const test = await fixture({ plugin: paths[0], pack: args.includes("--pack") })
let passed = false
let failure: unknown
const correction: Correction = { original: "gives advices", replacement: "gives advice", explanation: "Advice is uncountable. EARLIER_CORRECTION_SENTINEL." }
const sourceModel: ModelRef = { providerID, id: "source", variant: "high" }
const status = (sessionID: string) => test.rpc.status({ sessionID }, test.rpcOptions)
const view = (sessionID: string) => test.rpc.view({ sessionID }, test.rpcOptions)
const toggle = (sessionID: string, enabled: boolean) => test.rpc.setEnabled({ sessionID, enabled }, test.rpcOptions)
const create = async (title: string, parentID?: string, model: ModelRef = sourceModel) => (await test.client.session.create({
  title: `Synthetic ${title}`, location: { directory: test.workspace }, model, ...(parentID ? { parentID } : {}),
  metadata: { sentinel: "SESSION_METADATA_SENTINEL" },
})).id
const prompt = async (sessionID: string, text: string, extra: Partial<SessionPromptInput> = {}) => {
  const admitted = await test.client.session.prompt({ ...extra, sessionID, text })
  await test.client.session.wait({ sessionID })
  assert.equal((await test.client.session.get({ sessionID })).outcome, "succeeded", "Coding assistant failed")
  return admitted
}
const analyze = async (sessionID: string, marker: string, result: Correction[] | string = [correction], extra: Partial<SessionPromptInput> = {}) => {
  const before = test.teachers().length
  const count = (await status(sessionID)).count
  test.reply(marker, result)
  await prompt(sessionID, marker, extra)
  await test.until(() => test.teachers().length > before, "isolated teacher request")
  await test.until(async () => (await status(sessionID)).pending === 0, "teacher job completion")
  assert.equal(test.teachers().length, before + 1, "One admission must cause exactly one analysis")
  const current = await status(sessionID)
  const expected = Array.isArray(result) && result.length > 0 ? 1 : 0
  assert.equal(current.count, count + expected)
  assert.equal(Boolean(current.error), typeof result === "string", "Malformed results must differ from clean English")
  const request = test.teachers().at(-1)!
  assert.doesNotMatch(JSON.stringify(request.wire), /EARLIER_CORRECTION_SENTINEL/)
  if (expected) {
    const latest = (await view(sessionID)).comment!
    assert.deepEqual(latest.corrections, result)
    await test.until(() => test.corrected.some(event => event.data.commentID === latest.id), "correction event after persistence")
    assert.equal(test.corrected.filter(event => event.data.commentID === latest.id).length, 1)
  }
  return request
}
const assertSilent = async (action: () => Promise<unknown>) => {
  const before = test.teachers().length
  const notices = test.corrected.length
  await action()
  await test.quiet()
  assert.equal(test.teachers().length, before, "Excluded input caused analysis")
  assert.equal(test.corrected.length, notices, "Silent input caused a correction event")
}

try {
  test.stage("production discovery, authenticated RPC and independent settings")
  const root = await create("orchard session")
  const other = await create("independent session")
  assert.equal((await status(root)).enabled, true)
  assert.equal((await status(root)).overridden, false)
  const unauthorized = await fetch(`${test.url}/api/rpc/english-teacher/status`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: { sessionID: root } }), signal: AbortSignal.timeout(10_000),
  })
  assert.equal(unauthorized.status, 401)
  assert.equal((await toggle(root, false)).overridden, true)
  assert.equal((await status(other)).enabled, true)
  await assertSilent(() => prompt(root, "The prior example is a synthetic baseline. PRIOR_CONTEXT_SENTINEL."))
  await assertSilent(() => toggle(root, true))
  test.checks.push("production server/TUI discovery; native RPC authentication; independent persisted toggle; enabling does not backfill")

  test.stage("single-message wire isolation and correction persistence")
  const firstWire = await analyze(root, "The orchard example gives advices.", [correction], {
    files: [{ uri: png, name: "ATTACHMENT_SENTINEL.png", description: "ATTACHMENT_SENTINEL description" }],
  })
  assert.equal(firstWire.wire.model, "source")
  assert.equal(firstWire.wire.reasoning_effort, "high")
  const coding = test.requests.filter(request => request.sessionID === root).at(-1)!
  const codingText = JSON.stringify(coding.wire)
  assert.ok(coding.wire.tools?.length, "Isolation control missing: coding tools")
  for (const sentinel of ["PRIOR_CONTEXT_SENTINEL", "ASSISTANT_CONTEXT_SENTINEL", "REPOSITORY_INSTRUCTIONS_SENTINEL", "image_url"]) {
    assert.ok(codingText.includes(sentinel), `Isolation control missing from coding request: ${sentinel}`)
  }
  const first = (await view(root)).comment!
  assert.deepEqual(first.model, sourceModel)
  assert.equal((await test.client.session.list({ parentID: root })).data.length, 0, "Teacher created helper sessions")
  const history = await test.client.session.context({ sessionID: root })
  assert.equal(history.filter(message => message.type === "user").length, 2)
  assert.ok(!JSON.stringify(history).includes("EARLIER_CORRECTION_SENTINEL"), "Teacher wrote into coding history")
  test.checks.push("captured teacher wire: one text-only message, no history/instructions/media/tools/metadata/corrections; inherited model and variant; no helper/session writes")

  test.stage("clean and malformed results remain out of commented history")
  const notices = test.corrected.length
  await analyze(root, "The clean birch example is already correct.", [])
  assert.equal(test.corrected.length, notices)
  assert.equal((await view(root)).comment?.id, first.id)
  await analyze(root, "The malformed cedar example gives advices.", "not a supported JSON result")
  assert.equal(test.corrected.length, notices)
  assert.equal((await test.rpc.list({ sessionID: root }, test.rpcOptions)).total, 1)
  test.checks.push("empty response is silent; malformed result exposes error without retry, notification or history row; coding prompt succeeds")

  test.stage("global teacher prompt creation, customization, and recovery")
  const teacherFile = join(test.root, "config", "opencode", "english-teacher.md")
  assert.equal((await readFile(teacherFile, "utf8")).trim(), DEFAULT_TEACHER_PROMPT)
  const custom = DEFAULT_TEACHER_PROMPT + "\nCUSTOM_TEACHING_SENTINEL: emphasize verb agreement.\n"
  await writeFile(teacherFile, custom)
  const customized = await analyze(root, "The custom teaching pear example is already correct.", [])
  assert.ok(JSON.stringify(customized.wire).includes("CUSTOM_TEACHING_SENTINEL"))
  assert.equal(await readFile(teacherFile, "utf8"), custom)
  await unlink(teacherFile)
  await analyze(root, "The restored teaching peach example is already correct.", [])
  assert.equal((await readFile(teacherFile, "utf8")).trim(), DEFAULT_TEACHER_PROMPT)
  await writeFile(teacherFile, "")
  await assertSilent(async () => {
    await prompt(root, "The empty prompt apricot example is already correct.")
    await test.until(async () => /prompt/i.test((await status(root)).error ?? ""), "prompt file failure is visible")
  })
  assert.equal(await readFile(teacherFile, "utf8"), "")
  await writeFile(teacherFile, DEFAULT_TEACHER_PROMPT + "\n")
  await analyze(root, "The recovered teaching plum example is already correct.", [])
  test.checks.push("global prompt initialized once, edits reach isolated requests without reload, deletion recreates defaults, empty file fails visibly without overwrite or provider call")

  test.stage("root-only eligibility and locally excluded inputs")
  const child = await create("child session", root)
  assert.equal((await status(child)).eligible, false)
  await assertSilent(() => prompt(child, "The child example gives advices."))
  await assertSilent(async () => {
    await test.client.session.synthetic({ sessionID: root, text: "The synthetic notification gives advices.", resume: false })
  })
  for (const text of ["```ts\nconst copied = 'gives advices';\n```", "Это синтетический пример без английского текста."]) {
    await assertSilent(() => prompt(root, text))
  }
  await assertSilent(() => prompt(root, "", { files: [{ uri: png, name: "ATTACHMENT_SENTINEL.png" }] }))
  const fork = await test.client.session.fork({ sessionID: root })
  assert.equal((await status(fork.id)).count, 0)
  await assertSilent(() => status(fork.id))
  test.checks.push("child, synthetic, code-only, non-English and attachment-only admissions skip analysis; fork has no inherited history or backfill")

  test.stage("admissions during active assistant work and source-order navigation")
  const busy = await create("busy session")
  const busyMarker = "The coding hold example gives advices."
  const queuedMarker = "The queued maple example gives advices."
  test.reply(busyMarker, [correction])
  test.reply(queuedMarker, [correction])
  await test.client.session.prompt({ sessionID: busy, text: busyMarker })
  await test.until(() => test.held(`coding:${busy}`), "held coding assistant request")
  await test.client.session.prompt({ sessionID: busy, text: queuedMarker, delivery: "queue" })
  await test.until(async () => (await status(busy)).count === 2, "queued admission analyzed while assistant is busy")
  test.release(`coding:${busy}`)
  await test.client.session.wait({ sessionID: busy })
  assert.equal((await test.client.session.get({ sessionID: busy })).outcome, "succeeded")
  const newest = await view(busy)
  assert.equal(newest.total, 2)
  assert.ok(newest.comment?.preview.includes("queued maple"))
  const older = await test.rpc.view({ sessionID: busy, id: newest.comment!.id, direction: "older" }, test.rpcOptions)
  assert.ok(older.comment?.preview.includes("coding hold"))
  assert.equal((await test.rpc.view({ sessionID: busy, id: older.comment!.id, direction: "older" }, test.rpcOptions)).comment?.id, older.comment?.id)
  assert.equal((await test.rpc.view({ sessionID: busy, id: older.comment!.id, direction: "newer" }, test.rpcOptions)).comment?.id, newest.comment?.id)
  const page = await test.rpc.list({ sessionID: busy, limit: 1 }, test.rpcOptions)
  assert.equal(page.items[0].id, newest.comment!.id)
  assert.ok(page.next)
  assert.equal((await test.rpc.list({ sessionID: busy, cursor: page.next!, limit: 1 }, test.rpcOptions)).items[0].id, older.comment!.id)
  test.checks.push("busy/queued admissions analyzed independently; source ordering, older/newer boundaries and paginated corrected-only list")

  test.stage("disable held analysis: cancellation and no late publication")
  const heldMarker = "The delayed willow example gives advices."
  const count = (await status(root)).count
  test.reply(heldMarker, [correction], true)
  await prompt(root, heldMarker)
  await test.until(() => test.held(heldMarker), "held teacher request")
  assert.ok((await status(root)).pending > 0)
  await toggle(root, false)
  await test.until(() => test.held(heldMarker)?.closed, "Effect cancellation closes the teacher transport")
  test.release(heldMarker)
  await test.quiet()
  assert.equal((await status(root)).count, count)
  assert.equal((await status(root)).pending, 0)
  await assertSilent(() => toggle(root, true))
  test.checks.push("disabling interrupts held teacher transport, preserves comments, prevents late publication and re-enable replay without interrupting coding")

  test.stage("delete source session while its teacher request is held")
  const independentHistory = await test.rpc.list({ sessionID: busy }, test.rpcOptions)
  const independentTranscript = await test.client.session.context({ sessionID: busy })
  const deleted = await create("deletion session")
  await analyze(deleted, "The earlier hazel example gives advices.")
  const deletedMarker = "The deleted juniper example gives advices."
  test.reply(deletedMarker, [correction], true)
  await prompt(deleted, deletedMarker)
  await test.until(() => test.held(deletedMarker), "teacher request held before session deletion")
  assert.ok((await status(deleted)).pending > 0)
  const deletedCalls = test.teachers().length
  const deletedNotices = test.corrected.filter(event => event.data.sessionID === deleted).length
  await test.client.session.remove({ sessionID: deleted })
  await assert.rejects(test.client.session.get({ sessionID: deleted }), error => isSessionNotFoundError(error) && error.sessionID === deleted)
  assert.ok(!(await test.client.session.list({ directory: test.workspace })).data.some(session => session.id === deleted))
  await test.until(() => test.held(deletedMarker)?.closed, "session deletion interrupts teacher transport")
  const unavailable = (error: unknown) => Boolean(error && typeof error === "object" && "type" in error && error.type === "unavailable")
  await assert.rejects(view(deleted), unavailable)
  await assert.rejects(test.rpc.list({ sessionID: deleted }, test.rpcOptions), unavailable)
  test.release(deletedMarker)
  await test.quiet(1_000)
  assert.equal(test.teachers().length, deletedCalls, "Deleted analysis was retried")
  assert.equal(test.corrected.filter(event => event.data.sessionID === deleted).length, deletedNotices, "Deleted analysis published a late correction")
  await assert.rejects(view(deleted), unavailable)
  await assert.rejects(test.client.session.get({ sessionID: deleted }), error => isSessionNotFoundError(error) && error.sessionID === deleted)
  assert.deepEqual(await test.rpc.list({ sessionID: busy }, test.rpcOptions), independentHistory)
  assert.deepEqual(await test.client.session.context({ sessionID: busy }), independentTranscript)
  test.checks.push("installed session deletion interrupts held teacher work; native SessionNotFound confirms deletion; no late correction event, readable comment or retry; independent history/transcript unchanged")

  test.stage("implicit selected-agent and location-default models")
  for (const [agent, label, expected] of [
    ["fixture-agent", "selected agent", { providerID, id: "teacher", variant: "low" }],
    ["fixture-default", "location default", { providerID, id: "source" }],
  ] as const) {
    const agentInfo = (await test.client.agent.get({ agentID: agent, location: { directory: test.workspace } })).data
    if (agent === "fixture-agent") assert.deepEqual(agentInfo.model, expected)
    else assert.equal(agentInfo.model, undefined)
    const session = await test.client.session.create({ title: `Synthetic implicit ${label}`, agent, location: { directory: test.workspace } })
    assert.equal(session.model, undefined, "Implicit-model fixture unexpectedly has an explicit session model")
    const request = await analyze(session.id, `The implicit ${label} example gives advices.`)
    assert.deepEqual((await view(session.id)).comment!.model, expected)
    assert.equal(request.wire.model, expected.id)
    assert.equal(request.wire.reasoning_effort, "variant" in expected ? expected.variant : undefined)
    const codingRequest = test.requests.filter(request => request.sessionID === session.id).at(-1)!
    assert.equal(codingRequest.wire.model, request.wire.model)
    assert.equal(codingRequest.wire.reasoning_effort, request.wire.reasoning_effort)
    const after = await test.client.session.get({ sessionID: session.id })
    assert.equal(after.agent, agent)
    assert.equal(after.model, undefined, "Teacher wrote an implicit model into session selection")
  }
  test.checks.push("sessions without explicit model inherit selected-agent model/variant or location default; teacher and coding wire agree; session model/agent unchanged")

  test.stage("all model/variant overrides and invalid configuration")
  for (const [name, options, expected] of [
    ["model", { model: `${providerID}/teacher` }, { providerID, id: "teacher" }],
    ["variant", { variant: "low" }, { ...sourceModel, variant: "low" }],
    ["both", { model: `${providerID}/teacher`, variant: "low" }, { providerID, id: "teacher", variant: "low" }],
  ] as const) {
    await test.writeOptions({ enabledByDefault: false, ...options })
    await test.until(async () => !(await status(other)).enabled, "watched default change")
    await test.loaded()
    const selectionSession = await create(`selection ${name}`)
    await toggle(selectionSession, true)
    const request = await analyze(selectionSession, `The ${name} selection example gives advices.`)
    assert.deepEqual((await view(selectionSession)).comment!.model, expected)
    assert.equal(request.wire.model, expected.id)
    assert.equal(request.wire.reasoning_effort, "variant" in expected ? expected.variant : undefined)
    assert.deepEqual((await test.client.session.get({ sessionID: selectionSession })).model, sourceModel, "Plugin changed coding model")
    await test.writeOptions({})
    await test.until(async () => (await status(other)).enabled, "watched default restoration")
  }
  await test.writeOptions({ enabledByDefault: "invalid" })
  await test.until(async () => Boolean((await status(root)).error), "invalid options fail closed")
  await test.loaded()
  await assertSilent(() => prompt(root, "The invalid configuration example gives advices."))
  assert.equal((await view(root)).comment!.id, first.id)
  await test.writeOptions({ variant: "not-a-real-variant" })
  await test.until(async () => !(await status(other)).error, "valid configuration with unavailable variant loaded")
  const unsupported = await create("unsupported selection")
  await assertSilent(async () => {
    await prompt(unsupported, "The unavailable variant example gives advices.")
    await test.until(async () => Boolean((await status(unsupported)).error), "unsupported variant status")
  })
  assert.equal((await status(unsupported)).count, 0)
  await test.writeOptions({ enabledByDefault: false })
  await test.until(async () => !(await status(other)).enabled, "unsupported variant removed with observable default change")
  await test.writeOptions({})
  await test.until(async () => (await status(other)).enabled && !(await status(root)).error, "configuration recovery")
  test.checks.push("four model/variant selection combinations verified on wire and storage; source model untouched; reload updates defaults but preserves overrides; invalid options suspend generation; unavailable variant fails without fallback")

  test.stage("private restart preserves storage without replaying work or notifications")
  await toggle(root, false)
  const saved = await test.rpc.list({ sessionID: busy }, test.rpcOptions)
  const restartMarker = "The interrupted spruce example gives advices."
  test.reply(restartMarker, [correction], true)
  await prompt(other, restartMarker)
  await test.until(() => test.held(restartMarker), "pending work before restart")
  const callsBefore = test.teachers().length
  const eventsBefore = test.corrected.length
  await test.restart()
  assert.equal((await status(root)).enabled, false)
  assert.equal((await status(root)).overridden, true)
  assert.equal((await status(other)).enabled, true)
  assert.equal((await status(other)).pending, 0)
  assert.deepEqual(await test.rpc.list({ sessionID: busy }, test.rpcOptions), saved)
  assert.equal((await view(root)).comment!.id, first.id)
  test.release(restartMarker)
  await test.quiet(1_000)
  assert.equal(test.teachers().length, callsBefore)
  assert.equal(test.corrected.length, eventsBefore)
  await assertSilent(() => toggle(root, true))
  await analyze(root, "The fresh poplar example gives advices.")
  test.checks.push("restart retains explicit per-session settings and comments, clears pending ownership, and performs no backfill, retry or correction-event replay")

  if (args.includes("--tui")) {
    test.stage("installed TUI through PTY")
    const { verifyTui } = await import("./host-tui.ts")
    await verifyTui(test, busy)
    test.checks.push("installed TUI slash/palette, RPC, latest comment, page navigation, arrow scrolling, list/toggle/Escape, resize and input ownership")
  }
  for (const event of test.corrected) {
    assert.deepEqual(Object.keys(event.data).sort(), ["commentID", "sessionID", "sessionTitle"])
    assert.equal(event.location.directory, test.workspace)
  }
  assert.deepEqual(await test.client.credential.list(), [])
  passed = true
} catch (error) {
  failure = error
  process.exitCode = 1
} finally {
  await test.close(passed, failure)
  console.log(JSON.stringify({ passed, checks: test.checks, artifacts: test.root }, null, 2))
  if (failure) console.error(failure instanceof Error ? failure.message : "Synthetic smoke failed")
}
