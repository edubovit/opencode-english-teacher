import type { Comment, CommentList, Status, View } from "../src/contracts.ts"
import type { TeacherRemote } from "../src/ui/client.ts"

export function comment(id: string, long = false): Comment {
  return {
    id, sessionID: "session-a", preview: `Source ${id}: I need advices about café 日本語 👩‍💻.`,
    sourceTime: 1700000000000 + Number(id.replace(/\D/g, "") || 0), completedAt: 1700000100000,
    model: { providerID: "fixture", id: "teacher" },
    corrections: Array.from({ length: long ? 5 : 1 }, (_, index) => ({
      original: `original ${id} ${index}${long ? " with a very long phrase repeated".repeat(7) : ""}`,
      replacement: `replacement café 日本語 👩‍💻 ${index}${long ? " long replacement words".repeat(7) : ""}`,
      explanation: long ? "Use this grammar when speaking about a general idea. ".repeat(3) + `END-${index}` : "Simple explanation.",
    })),
  }
}

export function fixture(items = [comment("newest"), comment("older")]) {
  const data = { items, enabled: true, eligible: true, pending: 0, error: null as string | null }
  const status = (): Status => ({ protocol: 1, sessionID: "session-a", enabled: data.enabled, eligible: data.eligible, overridden: false, pending: data.pending, count: data.items.length, error: data.error })
  const remote: TeacherRemote = {
    async view({ id, direction }) {
      let index = id ? data.items.findIndex(item => item.id === id) : 0
      if (index < 0) index = 0
      if (direction === "older") index = Math.min(index + 1, data.items.length - 1)
      if (direction === "newer") index = Math.max(index - 1, 0)
      return { status: status(), comment: data.items[index] ?? null, position: data.items.length ? index + 1 : 0, total: data.items.length }
    },
    async list(cursor) {
      const index = Number(cursor ?? 0)
      return { items: data.items.slice(index, index + 20), total: data.items.length, next: index + 20 < data.items.length ? String(index + 20) : null }
    },
    async setEnabled(enabled) { data.enabled = enabled; return status() },
  }
  return { data, remote, status }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export type { View, CommentList }
