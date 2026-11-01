import type { Context } from "@opencode/plugin/tui/context"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { displayText } from "./client.ts"
import type { TeacherModel } from "./model.ts"

export const INPUT_MODE = "english-teacher"
export type TeacherUI = Pick<Context, "theme" | "keymap">

export function sourceTime(time: number) {
  return new Date(time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

export function Teacher(props: { api: TeacherUI; model?: TeacherModel; title: string; close: () => void }) {
  const [state, setState] = createSignal(props.model?.state)
  const size = useTerminalDimensions()
  let body: ScrollBoxRenderable | undefined
  let list: ScrollBoxRenderable | undefined
  const release = props.api.keymap.mode.push(INPUT_MODE)
  onCleanup(release)
  if (props.model) {
    onCleanup(props.model.subscribe(setState))
    onCleanup(() => props.model?.dispose())
    onMount(() => { void props.model?.refresh() })
  }
  const status = () => state()?.view?.status
  const comment = () => state()?.view?.comment
  const isList = createMemo(() => state()?.mode === "list")
  const ownsInput = () => props.api.keymap.mode.current() === INPUT_MODE
  const short = () => size().height < 14
  const selectedID = createMemo(() => state()?.page?.items[state()?.selected ?? 0]?.id)
  const commentID = createMemo(() => comment()?.id)

  createEffect(() => {
    commentID()
    if (!isList() && body && !body.isDestroyed) body.scrollTo(0)
  })
  createEffect(() => {
    const id = selectedID()
    if (isList() && id && list && !list.isDestroyed) list.scrollChildIntoView(`english-row-${id}`)
  })

  function back() {
    if (isList()) props.model?.back()
    else props.close()
  }
  useKeyboard(key => {
    if (key.defaultPrevented || !ownsInput() || key.ctrl || key.meta || key.option) return
    const model = props.model
    const name = key.name
    if (!["escape", "t", "l", "r", "pageup", "pagedown", "up", "down", "return"].includes(name)) return
    key.preventDefault()
    key.stopPropagation()
    if (name === "escape") return back()
    if (!model) return
    if (name === "t") void model.toggle()
    if (name === "l") void model.openList()
    if (name === "r") { void model.refresh(); if (isList()) void model.refreshList() }
    if (name === "return" && isList()) void model.openSelected()
    if (name === "pageup" || name === "pagedown") {
      const direction = name === "pageup" ? "older" : "newer"
      void (isList() ? model.page(direction) : model.navigate(direction))
    }
    if (name === "up" || name === "down") {
      const delta = name === "up" ? -1 : 1
      if (isList()) void model.select(delta)
      else if (body && !body.isDestroyed) body.scrollBy(delta)
    }
  })

  return <box id="english-teacher" width="100%" height="100%" flexDirection="column" paddingLeft={1} paddingRight={1} backgroundColor={props.api.theme.background.base}>
    <box id="english-header" flexShrink={0} flexDirection="column">
      <text id="english-title" fg={props.api.theme.text.base} height={1} truncate><b>English teacher</b>{short() ? "" : ` · ${displayText(props.title)}`}</text>
      <text fg={props.api.theme.text.muted} height={1} truncate>{!props.model ? "No session" : status() ? `${status()!.eligible ? status()!.enabled ? "Analysis on" : "Analysis off" : "Unavailable in child sessions"}${status()!.pending ? ` · ${status()!.pending} pending` : ""}${state()?.loading ? " · Refreshing…" : ""}${state()?.toggling ? " · Saving…" : ""}` : "Loading…"}</text>
      <box flexDirection="row" height={1}>
        <text fg={props.api.theme.text.action.primary.base} onMouseDown={() => { if (ownsInput()) back() }}>Esc {isList() ? "back" : "close"}</text>
        <Show when={props.model}><text fg={props.api.theme.text.action.primary.base} onMouseDown={() => { if (ownsInput()) void props.model?.openList() }}> · l list</text><Show when={status()?.eligible}><text fg={props.api.theme.text.action.primary.base} onMouseDown={() => { if (ownsInput()) void props.model?.toggle() }}>{` · t ${status()?.enabled ? "off" : "on"}`}</text></Show><text fg={props.api.theme.text.action.primary.base} onMouseDown={() => { if (ownsInput()) { void props.model?.refresh(); if (isList()) void props.model?.refreshList() } }}> · r refresh</text></Show>
      </box>
    </box>
    <Show when={state()?.error || status()?.error}>
      <text id="english-error" flexShrink={0} fg={props.api.theme.text.feedback.error.base} maxHeight={short() ? 2 : 3} wrapMode="word">{state()?.error || status()?.error}</text>
    </Show>
    <Show when={isList()} fallback={<>
      <Show when={comment()}>{item => <box flexShrink={0} flexDirection="column">
        <text id="english-position" fg={props.api.theme.text.muted} height={1} truncate>{`${state()!.view!.position}/${state()!.view!.total}${size().width >= 60 ? " newest first" : ""} · ${sourceTime(item().sourceTime)}`}</text>
        <text id="english-preview" fg={props.api.theme.text.muted} maxHeight={short() ? 1 : 2} wrapMode="word">{displayText(item().preview)}</text>
      </box>}</Show>
      <scrollbox id="english-body" ref={body} flexGrow={1} flexBasis={0} minHeight={0} scrollX={false} contentOptions={{ flexDirection: "column", paddingRight: 1 }} scrollbarOptions={{ trackOptions: { backgroundColor: props.api.theme.background.base, foregroundColor: props.api.theme.scrollbar.base } }}>
        <Show when={comment()} fallback={<text fg={props.api.theme.text.base} wrapMode="word">{!props.model ? "Open a session first." : !status() ? state()?.error ? "History is unavailable." : "Loading comments…" : !status()!.eligible ? "English analysis is unavailable in child sessions." : "No comments yet."}</text>}>{item => <For each={item().corrections}>{(correction, index) => <text id={`english-correction-${index()}`} flexShrink={0} marginBottom={1} fg={props.api.theme.text.base} wrapMode="word">{`${item().corrections.length > 1 ? `${index() + 1}. ` : ""}"${displayText(correction.original)}" → "${displayText(correction.replacement)}"${correction.explanation ? ` — ${displayText(correction.explanation)}` : ""}`}</text>}</For>}</Show>
      </scrollbox>
    </>}>
      <text fg={props.api.theme.text.muted} height={1} flexShrink={0} truncate>{`Comments · page ${(state()?.pageIndex ?? 0) + 1} · ${state()?.page?.total ?? 0} saved${state()?.listStale ? " · Updated: r refresh" : ""}${state()?.listLoading ? " · Loading…" : ""}`}</text>
      <scrollbox id="english-list" ref={list} flexGrow={1} flexBasis={0} minHeight={0} scrollX={false} contentOptions={{ flexDirection: "column", paddingRight: 1 }} scrollbarOptions={{ trackOptions: { backgroundColor: props.api.theme.background.base, foregroundColor: props.api.theme.scrollbar.base } }}>
        <Show when={state()?.page?.items.length} fallback={<text fg={props.api.theme.text.muted}>{state()?.listLoading ? "Loading history…" : state()?.error ? "History is unavailable." : "No comments yet."}</text>}>
          <For each={state()?.page?.items}>{(item, index) => <box id={`english-row-${item.id}`} flexShrink={0} flexDirection="column" backgroundColor={index() === state()?.selected ? props.api.theme.background.formfield.selected : props.api.theme.background.base}>
            <text fg={index() === state()?.selected ? props.api.theme.text.formfield.focused : props.api.theme.text.base} maxHeight={2} wrapMode="word">{`${index() === state()?.selected ? "›" : " "} ${displayText(item.preview)}`}</text>
            <text fg={props.api.theme.text.muted} height={1} truncate>{`#${(state()?.pageIndex ?? 0) * 20 + index() + 1} · ${sourceTime(item.sourceTime)}`}</text>
          </box>}</For>
        </Show>
      </scrollbox>
    </Show>
    <text id="english-hints" fg={props.api.theme.text.muted} flexShrink={0} wrapMode="word">{isList() ? "↑↓ select · Enter open · PgUp older page · PgDn newer page" : `↑↓ scroll · PgUp older · PgDn newer${(state()?.view?.position ?? 0) > 1 ? ` (${state()!.view!.position - 1})` : ""}`}</text>
  </box>
}
