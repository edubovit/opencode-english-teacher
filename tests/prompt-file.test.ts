import assert from "node:assert/strict"
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test, { type TestContext } from "node:test"
import { DEFAULT_TEACHER_PROMPT } from "../src/analysis.ts"
import { PromptFileError, promptFilePath, readTeacherPrompt } from "../src/prompt-file.ts"

async function fixture(t: TestContext): Promise<string> {
  const base = join(tmpdir(), "opencode")
  await mkdir(base, { recursive: true })
  const directory = await mkdtemp(join(base, "english-teacher-prompt-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function rejectsPrompt(path: string): Promise<void> {
  await assert.rejects(readTeacherPrompt(path), (error: unknown) => {
    assert.ok(error instanceof PromptFileError)
    assert.equal(error.name, "PromptFileError")
    assert.equal(error.message, new PromptFileError().message)
    assert.equal(error.cause, undefined)
    assert.equal(error.message.includes(path), false)
    assert.equal("code" in error, false)
    return true
  })
}

test("prompt path uses only an absolute XDG config home or the home fallback", () => {
  const home = resolve("isolated-home")
  const xdg = resolve("isolated-xdg")
  const fallback = join(home, ".config", "opencode", "english-teacher.md")
  assert.equal(promptFilePath({}, home), fallback)
  for (const XDG_CONFIG_HOME of ["", " ", "relative/config", "./config", "~/config"]) {
    assert.equal(promptFilePath({ XDG_CONFIG_HOME, OPENCODE_CONFIG_DIR: xdg }, home), fallback)
  }
  assert.equal(promptFilePath({ XDG_CONFIG_HOME: xdg, OPENCODE_CONFIG_DIR: home }, home), join(xdg, "opencode", "english-teacher.md"))
  assert.equal(promptFilePath(), promptFilePath(process.env, homedir()))
})

test("first read creates missing directories and the complete default with a trailing newline", async (t) => {
  const directory = await fixture(t)
  const path = join(directory, "config", "opencode", "english-teacher.md")
  const expected = DEFAULT_TEACHER_PROMPT.endsWith("\n") ? DEFAULT_TEACHER_PROMPT : `${DEFAULT_TEACHER_PROMPT}\n`
  assert.equal(await readTeacherPrompt(path), expected)
  assert.equal(await readFile(path, "utf8"), expected)
  assert.deepEqual(await readdir(dirname(path)), ["english-teacher.md"])
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    assert.equal((await stat(dirname(path))).mode & 0o777, 0o700)
    assert.equal((await stat(dirname(dirname(path)))).mode & 0o777, 0o700)
  }
})

test("existing custom prompt bytes are preserved and edits are read on every call", async (t) => {
  const directory = await fixture(t)
  const path = join(directory, "english-teacher.md")
  for (const custom of ["  My custom teacher — résumé.\r\n", "Teach only articles.", "Updated again.\n"]) {
    await writeFile(path, custom, "utf8")
    assert.equal(await readTeacherPrompt(path), custom)
    assert.equal(await readFile(path, "utf8"), custom)
  }
  assert.deepEqual(await readdir(directory), ["english-teacher.md"])
})

test("concurrent initialization publishes only complete defaults and removes temporary files", async (t) => {
  const directory = await fixture(t)
  const path = join(directory, "config", "opencode", "english-teacher.md")
  const prompts = await Promise.all(Array.from({ length: 40 }, () => readTeacherPrompt(path)))
  const saved = await readFile(path, "utf8")
  assert.equal(saved.trimEnd(), DEFAULT_TEACHER_PROMPT.trimEnd())
  assert.ok(saved.endsWith("\n"))
  assert.ok(prompts.every((prompt) => prompt === saved))
  assert.deepEqual(await readdir(dirname(path)), ["english-teacher.md"])
})

test("concurrent readers never replace existing custom or blank files", async (t) => {
  const directory = await fixture(t)
  const path = join(directory, "english-teacher.md")
  await writeFile(path, "Existing custom instructions")
  assert.deepEqual(await Promise.all(Array.from({ length: 12 }, () => readTeacherPrompt(path))), Array(12).fill("Existing custom instructions"))
  await writeFile(path, "")
  await Promise.all(Array.from({ length: 12 }, () => rejectsPrompt(path)))
  assert.equal(await readFile(path, "utf8"), "")
  assert.deepEqual(await readdir(directory), ["english-teacher.md"])
})

test("empty and whitespace-only prompts fail without modification", async (t) => {
  const directory = await fixture(t)
  const path = join(directory, "english-teacher.md")
  for (const content of ["", " \r\n\t", "\uFEFF\u2003\n"]) {
    await writeFile(path, content)
    await rejectsPrompt(path)
    assert.equal(await readFile(path, "utf8"), content)
  }
})

test("prompt size limit is 64 KiB of bytes, inclusive", async (t) => {
  const directory = await fixture(t)
  const path = join(directory, "english-teacher.md")
  const boundary = "é".repeat(32 * 1024)
  await writeFile(path, boundary)
  assert.equal(await readTeacherPrompt(path), boundary)
  for (const content of [boundary + "x", "é".repeat(40 * 1024), "private oversized prompt ".repeat(100_000)]) {
    await writeFile(path, content)
    await rejectsPrompt(path)
    assert.equal((await stat(path)).size, Buffer.byteLength(content))
  }
})

test("invalid UTF-8 is rejected without modifying the file", async (t) => {
  const directory = await fixture(t)
  const path = join(directory, "english-teacher.md")
  const bytes = Buffer.from([0xc3, 0x28])
  await writeFile(path, bytes)
  await rejectsPrompt(path)
  assert.deepEqual(await readFile(path), bytes)
})

test("directory targets and invalid parent paths produce only sanitized actionable errors", async (t) => {
  const directory = await fixture(t)
  const path = join(directory, "private-secret-path")
  await mkdir(path)
  await rejectsPrompt(path)
  await writeFile(join(directory, "not-a-directory"), "private secret contents")
  await rejectsPrompt(join(directory, "not-a-directory", "english-teacher.md"))
  assert.equal(await readFile(join(directory, "not-a-directory"), "utf8"), "private secret contents")
  assert.match(new PromptFileError().message, /readable, nonblank.*64 KiB/u)
})

test("unreadable prompts fail without overwriting them", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async (t) => {
  const directory = await fixture(t)
  const path = join(directory, "english-teacher.md")
  await writeFile(path, "Private custom instructions")
  await chmod(path, 0o000)
  try {
    await rejectsPrompt(path)
  } finally {
    await chmod(path, 0o600)
  }
  assert.equal(await readFile(path, "utf8"), "Private custom instructions")
})

test("user-managed file symlinks are followed but dangling links are never replaced", async (t) => {
  const directory = await fixture(t)
  const target = join(directory, "custom.md")
  const path = join(directory, "english-teacher.md")
  await writeFile(target, "Linked custom prompt")
  try {
    await symlink(target, path, "file")
  } catch (error) {
    if (process.platform === "win32" && error instanceof Error && "code" in error && error.code === "EPERM") {
      t.skip("Creating file symlinks requires Windows privileges")
      return
    }
    throw error
  }
  assert.equal(await readTeacherPrompt(path), "Linked custom prompt")
  await writeFile(target, "Edited linked prompt")
  assert.equal(await readTeacherPrompt(path), "Edited linked prompt")
  await rm(target)
  await rejectsPrompt(path)
  assert.ok((await lstat(path)).isSymbolicLink())
  assert.deepEqual(await readdir(directory), ["english-teacher.md"])
})
