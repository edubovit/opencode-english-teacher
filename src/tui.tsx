import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { PLUGIN_ID } from "./contracts.ts"
import { teacherRemote, watchTeacher } from "./ui/client.ts"
import { TeacherModel } from "./ui/model.ts"
import { Teacher } from "./ui/teacher.tsx"

const PAGE = "english"

export default Plugin.define({
  id: PLUGIN_ID,
  setup(api) {
    const views = new Map<TeacherModel, string>()
    const seen = new Set<string>()
    const [connectionEpoch, setConnectionEpoch] = createSignal(0)
    const [opening, setOpening] = createSignal(1)
    let disposed = false
    const refresh = (sessionID?: string) => {
      if (disposed) return
      for (const [model, id] of views) if (!sessionID || id === sessionID) model.changed()
    }
    const connectedOff = api.data.on("server.connected", () => {
      if (!disposed) setConnectionEpoch(value => value + 1)
    })
    const routeOff = api.ui.router.register({
      name: PAGE,
      render: ({ data }) => <Show keyed when={opening()}>{(_generation) => {
        const sessionID = typeof data?.sessionID === "string" ? data.sessionID : undefined
        const model = sessionID ? new TeacherModel(teacherRemote(api, sessionID)) : undefined
        if (model && sessionID) {
          views.set(model, sessionID)
          onCleanup(() => { views.delete(model); model.dispose() })
        }
        return <Teacher api={api} model={model} title={sessionID ? api.data.session.get(sessionID)?.title || sessionID : ""} close={() => {
          if (!disposed) api.ui.router.navigate(sessionID ? { type: "session", sessionID } : { type: "home" })
        }} />
      }}</Show>,
    })
    const slotOff = api.ui.slot({
      append: "app",
      render: () => {
        createEffect(() => {
          connectionEpoch()
          api.client
          onCleanup(watchTeacher(api, refresh, seen))
          refresh()
        })
        return null
      },
    })
    api.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "english-teacher.open",
        title: "English teacher",
        group: "Session",
        palette: true,
        slash: { name: "english" },
        run() {
          if (disposed) return
          const route = api.ui.router.current()
          if (route.type === "plugin" && route.id === PLUGIN_ID && route.name === PAGE) {
            setOpening(value => value + 1)
            return
          }
          const sessionID = route.type === "session" ? route.sessionID : undefined
          api.ui.router.navigate({ type: "plugin", name: PAGE, data: { ...(sessionID ? { sessionID } : {}) } })
        },
      }],
    }))
    return () => {
      disposed = true
      connectedOff()
      slotOff()
      for (const model of views.keys()) model.dispose()
      views.clear()
      routeOff()
    }
  },
})
