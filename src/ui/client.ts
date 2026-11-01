import type { Context } from "@opencode/plugin/tui/context"
import { EnglishTeacher } from "../rpc.ts"
import type { CommentList, Status, View } from "../contracts.ts"

export type Selection = { id?: string; direction?: "older" | "newer" }

export interface TeacherRemote {
  view(selection: Selection, signal: AbortSignal): Promise<View>
  list(cursor: string | undefined, signal: AbortSignal): Promise<CommentList>
  setEnabled(enabled: boolean, signal: AbortSignal): Promise<Status>
}

export function teacherRemote(api: Pick<Context, "client">, sessionID: string): TeacherRemote {
  async function connection(signal: AbortSignal) {
    signal = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
    const client = api.client
    const session = await client.session.get({ sessionID }, { signal })
    signal.throwIfAborted()
    return { rpc: client.rpc(EnglishTeacher), options: { location: session.location, signal } }
  }
  return {
    async view(selection, signal) {
      const { rpc, options } = await connection(signal)
      return rpc.view({ sessionID, ...selection }, options)
    },
    async list(cursor, signal) {
      const { rpc, options } = await connection(signal)
      return rpc.list({ sessionID, limit: 20, ...(cursor ? { cursor } : {}) }, options)
    },
    async setEnabled(enabled, signal) {
      const { rpc, options } = await connection(signal)
      return rpc.setEnabled({ sessionID, enabled }, options)
    },
  }
}

export function displayText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim()
}

export function watchTeacher(
  api: Pick<Context, "client" | "ui">,
  changed: (sessionID: string) => void,
  seen = new Set<string>(),
): () => void {
  const scope = new AbortController()
  const client = api.client
  const rpc = client.rpc(EnglishTeacher)
  const changedOff = rpc.events.on("changed", event => {
    if (!scope.signal.aborted) changed(event.data.sessionID)
  }, { signal: scope.signal })
  const correctedOff = rpc.events.on("corrected", async event => {
    const { sessionID, commentID } = event.data
    const key = JSON.stringify([sessionID, commentID])
    if (scope.signal.aborted || seen.has(key)) return
    seen.add(key)
    const signal = AbortSignal.any([scope.signal, AbortSignal.timeout(15_000)])
    try {
      const session = await client.session.get({ sessionID }, { signal })
      if (signal.aborted || session.parentID || session.location.directory !== event.location.directory) return
      api.ui.toast.show({
        title: `English teacher · ${displayText(session.title || event.data.sessionTitle || sessionID).slice(0, 80)}`,
        message: "New comment saved. Open this session and use /english.",
        sessionID,
        variant: "info",
        duration: 5000,
      })
    } catch {
      if (!scope.signal.aborted) seen.delete(key)
    }
  }, { signal: scope.signal })
  return () => {
    scope.abort()
    changedOff()
    correctedOff()
  }
}
