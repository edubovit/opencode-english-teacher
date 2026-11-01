import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { makePrompt, parseCorrections, prepareText } from "../src/analysis.ts"

if (!process.argv.includes("--allow-usage")) {
  throw new Error("Live tests consume provider usage. Run with --allow-usage after obtaining permission.")
}

const executable = process.env.OPENCODE_BIN ?? (process.platform === "win32"
  ? join(dirname(process.execPath), "node_modules", "@opencode", "cli", "bin", "opencode.exe")
  : "opencode")
const model = { providerID: "openai", id: "gpt-6.1-terra", variant: "low" }
const cases = [
  { name: "grammar", input: "She don't know how to use it. I have went there yesterday.", minimum: 1 },
  { name: "clean", input: "Please add a test for this case and run the existing suite.", maximum: 0 },
  { name: "informal", input: "Looks good. Ship it.", maximum: 0 },
  { name: "mixed language", input: "Проверь эту функцию. This function return the wrong value.", minimum: 1 },
  { name: "French", input: "Je veut ajouter un test pour cette fonction, puis nous vérifie le résultat.", maximum: 0 },
  { name: "Spanish", input: "Yo no sabe cómo funciona esto y nosotros necesita ayuda.", maximum: 0 },
  { name: "copied code", input: "Please review this example.\n```text\nShe don't knows nothing.\n```", maximum: 0 },
  { name: "word choice", input: "Please give me some advices about this change.", minimum: 1 },
]

async function generate(prompt: string): Promise<string> {
  const child = spawn(executable, ["api", "post", "/api/experimental/generate/text", "--data", JSON.stringify({ model, prompt })], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  let output = ""
  let errorBytes = 0
  child.stdout.on("data", chunk => { output += chunk.toString() })
  child.stderr.on("data", chunk => { errorBytes += chunk.length })
  const timer = setTimeout(() => child.kill(), 120_000)
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", resolve)
    })
    assert.equal(code, 0, `Live generation failed (exit ${code}; ${errorBytes} diagnostic bytes, not printed).`)
    const result = JSON.parse(output) as { data?: { text?: unknown } }
    assert.equal(typeof result.data?.text, "string", "Unexpected generation response shape.")
    return result.data!.text as string
  } finally {
    clearTimeout(timer)
  }
}

for (const fixture of cases) {
  const text = prepareText(fixture.input)
  const corrections = text ? parseCorrections(await generate(makePrompt(text)), text) : []
  if (fixture.minimum !== undefined) assert.ok(corrections.length >= fixture.minimum, fixture.name)
  if (fixture.maximum !== undefined) assert.ok(corrections.length <= fixture.maximum, fixture.name)
  assert.ok(corrections.every(item => !/[\p{Script=Cyrillic}]/u.test(item.original)), fixture.name)
  const replacements = corrections.map(item => item.replacement).join(" ")
  if (fixture.name === "grammar") {
    assert.match(replacements, /does(?:n't|n’t| not)/u)
    assert.match(replacements, /\bwent\b/u)
  }
  if (fixture.name === "mixed language") assert.match(replacements, /\breturns\b/u)
  if (fixture.name === "word choice") assert.match(replacements, /\badvice\b/u)
  console.log(`PASS ${fixture.name}: ${corrections.length} correction(s)`)
}
console.log(`Live smoke passed using only ${model.providerID}/${model.id}#${model.variant}.`)
