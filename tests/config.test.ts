import assert from "node:assert/strict"
import { test } from "node:test"
import { ConfigError, parseOptions, selectModel } from "../src/config.ts"

const session = { providerID: "openai", id: "gpt-6.1-terra", variant: "high" }

test("default settings inherit model and variant without mutating the source", () => {
  const settings = parseOptions({})
  assert.deepEqual(settings, { enabledByDefault: true })
  assert.deepEqual(selectModel(settings, session), session)
  assert.notEqual(selectModel(settings, session), session)
  assert.deepEqual(parseOptions(undefined), settings)
})

test("model-only override does not inherit the source variant", () => {
  assert.deepEqual(selectModel(parseOptions({ model: "other/vendor/model" }), session), {
    providerID: "other", id: "vendor/model",
  })
})

test("variant-only and combined overrides", () => {
  assert.deepEqual(selectModel(parseOptions({ variant: "low" }), session), { ...session, variant: "low" })
  assert.deepEqual(selectModel(parseOptions({ model: "openai/gpt-6.1-terra", variant: "low", enabledByDefault: false })), {
    providerID: "openai", id: "gpt-6.1-terra", variant: "low",
  })
  assert.equal(parseOptions({ enabledByDefault: false }).enabledByDefault, false)
})

test("malformed and unknown options are rejected without echoing their values", () => {
  for (const options of [null, [], { extra: true }, { enabledByDefault: "false" }, { model: "model" },
    { model: "provider/" }, { model: "/model" }, { model: "provider/model#low" }, { model: " provider/model" },
    { variant: "" }, { variant: " low" }, { variant: null }, { model: "SECRET" }]) {
    assert.throws(() => parseOptions(options), error => error instanceof ConfigError && !error.message.includes("SECRET"))
  }
  assert.throws(() => selectModel(parseOptions({})), ConfigError)
})
