import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { link, mkdir, open, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { DEFAULT_TEACHER_PROMPT } from "./analysis.ts"

const maxBytes = 64 * 1024

export class PromptFileError extends Error {
  constructor() {
    super("The English teacher prompt is unavailable or invalid. Check that the global prompt is a readable, nonblank UTF-8 file no larger than 64 KiB, and that its directory allows initial creation.")
    this.name = "PromptFileError"
  }
}

export function promptFilePath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const root = env.XDG_CONFIG_HOME
  return join(root && isAbsolute(root) ? root : join(home, ".config"), "opencode", "english-teacher.md")
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}

async function initialize(path: string): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.english-teacher-${randomUUID()}.tmp`)
  const file = await open(temporary, "wx", 0o600)
  try {
    try {
      await file.writeFile(DEFAULT_TEACHER_PROMPT.endsWith("\n") ? DEFAULT_TEACHER_PROMPT : `${DEFAULT_TEACHER_PROMPT}\n`, "utf8")
    } finally {
      await file.close()
    }
    try {
      await link(temporary, path)
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error
    }
  } finally {
    await unlink(temporary)
  }
}

export async function readTeacherPrompt(path: string = promptFilePath()): Promise<string> {
  try {
    const flags = constants.O_RDONLY | constants.O_NONBLOCK
    const file = await open(path, flags).catch(async (error: unknown) => {
      if (!hasCode(error, "ENOENT")) throw error
      await initialize(path)
      return open(path, flags)
    })
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size > maxBytes) throw new PromptFileError()
      const buffer = Buffer.alloc(maxBytes + 1)
      let size = 0
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, size)
        if (!bytesRead) break
        size += bytesRead
      }
      if (size > maxBytes) throw new PromptFileError()
      const prompt = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size))
      if (!prompt.trim()) throw new PromptFileError()
      return prompt
    } finally {
      await file.close()
    }
  } catch {
    throw new PromptFileError()
  }
}
