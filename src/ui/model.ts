import type { CommentList, View } from "../contracts.ts"
import type { Selection, TeacherRemote } from "./client.ts"

export interface TeacherState {
  view?: View
  mode: "comment" | "list"
  loading: boolean
  toggling: boolean
  listLoading: boolean
  error?: string
  page?: CommentList
  pageIndex: number
  selected: number
  listStale: boolean
}

export class TeacherModel {
  state: TeacherState = { mode: "comment", loading: false, toggling: false, listLoading: false, pageIndex: 0, selected: 0, listStale: false }
  private scope = new AbortController()
  private readers = new Set<(state: TeacherState) => void>()
  private refreshQueued = false
  private cursors: (string | undefined)[] = [undefined]
  private pageRequest?: AbortController

  constructor(private remote: TeacherRemote) {}

  subscribe(listener: (state: TeacherState) => void) {
    this.readers.add(listener)
    return () => { this.readers.delete(listener) }
  }

  private update(patch: Partial<TeacherState>) {
    if (this.scope.signal.aborted) return
    this.state = { ...this.state, ...patch }
    this.readers.forEach(listener => listener(this.state))
  }

  async refresh() {
    if (this.scope.signal.aborted) return
    if (this.state.loading || this.state.toggling) {
      this.refreshQueued = true
      return
    }
    const id = this.state.view?.comment?.id
    await this.load(id ? { id } : {})
  }

  changed() {
    this.update({ listStale: !!this.state.page })
    void this.refresh()
  }

  private flush() {
    if (!this.refreshQueued || this.scope.signal.aborted) return
    this.refreshQueued = false
    void this.refresh()
  }

  private async load(selection: Selection) {
    if (this.scope.signal.aborted || this.state.loading || this.state.toggling) return
    this.update({ loading: true, error: undefined })
    try {
      const view = await this.remote.view(selection, this.scope.signal)
      this.update({ view })
    } catch {
      this.update({ error: "Could not load comments. Press r to retry; check the server plugin and connection." })
    } finally {
      this.update({ loading: false })
      this.flush()
    }
  }

  async navigate(direction: "older" | "newer") {
    const view = this.state.view
    if (!view?.comment || this.state.mode !== "comment") return
    if ((direction === "older" && view.position >= view.total) || (direction === "newer" && view.position <= 1)) return
    await this.load({ id: view.comment.id, direction })
  }

  async toggle() {
    const status = this.state.view?.status
    if (!status?.eligible || this.state.loading || this.state.toggling || this.scope.signal.aborted) return
    this.update({ toggling: true, error: undefined })
    try {
      const result = await this.remote.setEnabled(!status.enabled, this.scope.signal)
      if (this.state.view) this.update({ view: { ...this.state.view, status: result } })
    } catch {
      this.update({ error: "Could not change analysis. Press r to reload the server-owned setting." })
    } finally {
      this.update({ toggling: false })
      this.flush()
    }
  }

  async openList() {
    if (this.scope.signal.aborted) return
    this.update({ mode: "list" })
    if (!this.state.page) await this.loadPage(0)
  }

  back() {
    this.pageRequest?.abort()
    this.pageRequest = undefined
    this.update({ mode: "comment", listLoading: false })
  }

  async refreshList() {
    this.cursors = [undefined]
    await this.loadPage(0, false, this.state.page?.items[this.state.selected]?.id)
  }

  private async loadPage(index: number, last = false, selectedID?: string) {
    if (this.scope.signal.aborted || this.state.mode !== "list") return
    this.pageRequest?.abort()
    const request = new AbortController()
    this.pageRequest = request
    this.update({ listLoading: true, error: undefined })
    try {
      const page = await this.remote.list(this.cursors[index], AbortSignal.any([request.signal, this.scope.signal]))
      if (request.signal.aborted || this.scope.signal.aborted) return
      const preserved = selectedID ? page.items.findIndex(item => item.id === selectedID) : -1
      this.update({ page, pageIndex: index, selected: preserved >= 0 ? preserved : last ? Math.max(0, page.items.length - 1) : 0, listStale: false })
    } catch {
      if (!request.signal.aborted) this.update({ error: "Could not load history. Press r to retry." })
    } finally {
      if (this.pageRequest === request) {
        this.pageRequest = undefined
        this.update({ listLoading: false })
      }
    }
  }

  async page(direction: "older" | "newer") {
    if (this.state.listLoading) return
    if (direction === "newer") {
      if (this.state.pageIndex > 0) await this.loadPage(this.state.pageIndex - 1, true)
    } else if (this.state.page?.next) {
      this.cursors[this.state.pageIndex + 1] = this.state.page.next
      await this.loadPage(this.state.pageIndex + 1)
    }
  }

  async select(delta: number) {
    if (this.state.listLoading || !this.state.page) return
    const selected = this.state.selected + delta
    if (selected < 0) await this.page("newer")
    else if (selected >= this.state.page.items.length) await this.page("older")
    else this.update({ selected })
  }

  async openSelected() {
    const item = this.state.page?.items[this.state.selected]
    if (!item || this.state.listLoading || this.state.loading || this.state.toggling) return
    this.back()
    await this.load({ id: item.id })
  }

  dispose() {
    this.scope.abort()
    this.pageRequest?.abort()
    this.readers.clear()
  }
}
