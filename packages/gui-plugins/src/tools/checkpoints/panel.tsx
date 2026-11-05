// The Checkpoints tool: every request that changed files, as a tree of the paths the conversation took. Selecting one
// shows what it changed; going to it puts the files and the conversation back as they were, with an undo right after.

import { createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import { Icon } from "@opencode/ui/icon"
import { Tooltip } from "@opencode/ui/tooltip"
import type { Checkpoint } from "@opencode/schema/checkpoint"
import type { FileDiff } from "@opencode/schema/file-diff"
import { SessionReviewFilePreviewV2 } from "@opencode/session-ui/v2/session-review-file-preview-v2"
import { Busy, card, Counts, FilePath, iconButton, kicker, Note, primary, quiet, secondary, Spinner } from "../ui"
import { StatusChip } from "./ui"
import { confirmText, relativeTime, timeline, type Rail, type Row, type Words } from "./model"
import type { CheckpointView, Mode } from "./view"

export function CheckpointsPanel(props: { view: CheckpointView }) {
  const ctx = usePlugin()

  return (
    <div data-component="tools-checkpoints" class="@container flex flex-col gap-4 pb-10">
      <div class="flex items-start gap-3">
        <div class="flex flex-1 min-w-0 flex-col gap-1">
          <div class="flex items-center gap-2">
            <span class="text-16-medium text-v2-text-text-base">{ctx.t("checkpoints.title")}</span>
            <Show when={props.view.nodes().length > 0}>
              <span class="inline-flex items-center h-5 px-1.5 rounded-md bg-v2-overlay-simple-overlay-hover text-[11px] font-medium tabular-nums text-v2-text-text-muted">
                {props.view.nodes().length}
              </span>
            </Show>
          </div>
          <div class="text-[13px] text-v2-text-text-muted">{ctx.t("checkpoints.description")}</div>
        </div>
        <Tooltip value={ctx.t("checkpoints.refresh")} placement="left">
          <button
            type="button"
            data-action="checkpoints-refresh"
            aria-label={ctx.t("checkpoints.refresh")}
            class={`${iconButton} size-8`}
            onClick={() => void props.view.refresh()}
          >
            <Icon name="refresh" size="small" />
          </button>
        </Tooltip>
      </div>
      {/* A session switch brings another view without remounting the panel; its body starts afresh with it. */}
      <Show when={props.view} keyed>
        {(view) => <Body view={view} />}
      </Show>
    </div>
  )
}

function Body(props: { view: CheckpointView }) {
  const ctx = usePlugin()
  const view = props.view

  // The clock the relative times read, a minute at a time.
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 60_000)

  onCleanup(() => clearInterval(timer))

  const words = () => ({ t: ctx.t, plural: ctx.plural, locale: ctx.locale.locale() })

  const undo = async () => {
    const done = await view.undo()

    if (done === true) return ctx.toast.show({ variant: "success", title: ctx.t("checkpoints.undone") })

    if (done === false) return ctx.toast.show({ title: ctx.t("checkpoints.undo.nothing") })

    if (done === "waiting") return ctx.toast.show({ title: ctx.t("checkpoints.wait") })
    ctx.toast.show({
      variant: "error",
      title: done
        ? ctx.t("checkpoints.working", { session: done.title })
        : (view.error() ?? ctx.t("checkpoints.error.failed")),
    })
  }

  const jump = async (target: Checkpoint.Node) => {
    const overwritten = await view.overwritten(target.key).catch(() => undefined)
    const text = confirmText(target, overwritten, words())

    if (!(await ctx.dialogs.confirm(text))) return

    const moved = await view.jump(target.key)

    if (!moved) return

    if (moved !== true)
      return ctx.toast.show({ variant: "error", title: ctx.t("checkpoints.working", { session: moved.title }) })
    ctx.toast.show({
      variant: "success",
      title: ctx.t("checkpoints.moved", { title: target.title || ctx.t("checkpoints.untitled") }),
      duration: 10_000,
      actions: [{ label: ctx.t("checkpoints.undo"), run: () => void undo() }],
    })
  }

  return (
    <Show
      when={view.loaded()}
      fallback={
        <Show when={view.error()} fallback={<Loading />}>
          {(error) => (
            <Note tone="danger" icon="warning">
              {error()}
            </Note>
          )}
        </Show>
      }
    >
      <Show when={view.error()}>
        {(error) => (
          <div class="flex items-start gap-2">
            <div class="flex-1 min-w-0">
              <Note tone="danger" icon="warning">
                {error()}
              </Note>
            </div>
            <button
              type="button"
              aria-label={ctx.t("checkpoints.dismiss")}
              class={iconButton}
              onClick={() => view.dismissError()}
            >
              <Icon name="close-small" size="small" />
            </button>
          </div>
        )}
      </Show>
      <Switch>
        <Match when={!view.available()}>
          <Unavailable view={view} />
        </Match>
        <Match when={view.nodes().length === 0}>
          <Empty />
        </Match>
        <Match when={view.nodes().length > 0}>
          <Working view={view} />
          {/* What the user is looking at comes first; the timeline below is where they pick another checkpoint. */}
          <Show when={view.selected()} keyed>
            {(selected) => <Details view={view} node={selected} onJump={() => void jump(selected)} />}
          </Show>
          <Tree view={view} now={now()} words={words()} />
        </Match>
      </Switch>
    </Show>
  )
}

function Loading() {
  return (
    <div class="flex items-center justify-center py-16 text-v2-text-text-muted">
      <Spinner large />
    </div>
  )
}

function Empty() {
  const ctx = usePlugin()

  return (
    <div
      data-slot="checkpoints-empty"
      class="flex flex-col items-center gap-3 px-6 py-10 rounded-xl border border-dashed border-v2-border-border-base text-center"
    >
      <span class="flex items-center justify-center size-12 rounded-xl bg-v2-overlay-simple-overlay-hover text-v2-text-text-muted">
        <Icon name="outline-rotate-clockwise" />
      </span>
      <div class="flex flex-col gap-1 max-w-[340px]">
        <b class="text-14-medium text-v2-text-text-base">{ctx.t("checkpoints.empty.title")}</b>
        <span class="text-12-regular leading-[1.5] text-v2-text-text-muted">
          {ctx.t("checkpoints.empty.description")}
        </span>
      </div>
    </div>
  )
}

function Unavailable(props: { view: CheckpointView }) {
  const ctx = usePlugin()

  const enable = async () => {
    if (await props.view.enable()) ctx.toast.show({ variant: "success", title: ctx.t("checkpoints.enable.done") })
  }

  return (
    <div
      data-slot="checkpoints-unavailable"
      class="flex flex-col items-center gap-4 px-6 py-10 rounded-xl border border-dashed border-v2-border-border-base text-center"
    >
      <span class="flex items-center justify-center size-12 rounded-xl bg-[#0a3a78] text-[#fff]">
        <Icon name="outline-rotate-clockwise" />
      </span>
      <div class="flex flex-col gap-1 max-w-[340px]">
        <b class="text-14-medium text-v2-text-text-base">{ctx.t("checkpoints.enable.title")}</b>
        <span class="text-12-regular leading-[1.5] text-v2-text-text-muted">
          {ctx.t("checkpoints.enable.description")}
        </span>
      </div>
      <button
        type="button"
        data-action="checkpoints-enable"
        class={`${primary} h-9 px-4`}
        disabled={!!props.view.busy()}
        onClick={() => void enable()}
      >
        <Busy when={props.view.busy() === "enable"}>
          <Icon name="check" size="small" />
        </Busy>
        {ctx.t("checkpoints.enable.action")}
      </button>
    </div>
  )
}

/** Someone in this project is working, so nobody can move; this conversation's agent can be stopped from here. */
function Working(props: { view: CheckpointView }) {
  const ctx = usePlugin()

  return (
    <Show when={props.view.working()}>
      {(working) => (
        <div
          data-slot="checkpoints-working"
          class="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-v2-state-bg-warning text-12-regular"
        >
          <Spinner />
          <div class="flex flex-1 min-w-0 flex-col">
            <span class="truncate font-medium text-v2-text-text-base">
              {ctx.t("checkpoints.working", { session: working().title })}
            </span>
            <span class="text-v2-text-text-muted">{ctx.t("checkpoints.working.hint")}</span>
          </div>
          <Show when={working().mine}>
            <button
              type="button"
              data-action="checkpoints-stop"
              class={`${secondary} h-7 px-2.5`}
              onClick={() => props.view.stopAgent()}
            >
              <Icon name="stop" size="small" />
              {ctx.t("checkpoints.stop")}
            </button>
          </Show>
        </div>
      )}
    </Show>
  )
}

function Tree(props: { view: CheckpointView; now: number; words: Words }) {
  const ctx = usePlugin()
  const entries = createMemo(() => timeline(props.view.nodes()))
  const has = (path: Checkpoint.Node["path"]) => props.view.nodes().some((node) => node.path === path)

  return (
    <div data-slot="checkpoints-tree" class={card}>
      <div class="flex flex-col gap-0.5">
        <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span class={kicker}>{ctx.t("checkpoints.timeline")}</span>
          <Legend has={has} />
        </div>
        <span class="text-12-regular text-v2-text-text-muted">{ctx.t("checkpoints.list")}</span>
      </div>
      <div role="listbox" aria-label={ctx.t("checkpoints.list")} class="flex flex-col -mx-2">
        <For each={entries()}>
          {(entry) => (
            <TreeRow
              row={entry.row}
              rail={entry.rail}
              current={props.view.current()?.key === entry.row.node.key}
              selected={props.view.selected()?.key === entry.row.node.key}
              time={relativeTime(entry.row.node.time, props.now, props.words)}
              onSelect={() => props.view.select(entry.row.node.key)}
            />
          )}
        </For>
      </div>
    </div>
  )
}

/** Which marker means what; undone and other-path markers only show when the timeline has them. */
function Legend(props: { has: (path: Checkpoint.Node["path"]) => boolean }) {
  const ctx = usePlugin()
  const has = (path: Checkpoint.Node["path"]) => props.has(path)

  return (
    <div class="flex items-center gap-3 text-[11px] text-v2-text-text-muted">
      <span class="inline-flex items-center gap-1.5">
        <Dot kind="here" />
        {ctx.t("checkpoints.here")}
      </span>
      <Show when={has("ahead")}>
        <span class="inline-flex items-center gap-1.5">
          <Dot kind="ahead" />
          {ctx.t("checkpoints.ahead")}
        </span>
      </Show>
      <Show when={has("branch")}>
        <span class="inline-flex items-center gap-1.5">
          <Dot kind="branch" />
          {ctx.t("checkpoints.branch")}
        </span>
      </Show>
    </div>
  )
}

const INDENT = 20

// The centre of the timeline dot for a path at `depth`, from the row's start.
const lane = (depth: number) => 18 + depth * INDENT

type DotKind = "here" | "past" | "ahead" | "branch"

/** A timeline marker: where the user is, an earlier checkpoint on their path, an undone one, or another path. */
function Dot(props: { kind: DotKind }) {
  return (
    <span
      aria-hidden="true"
      class="shrink-0 rounded-full"
      classList={{
        "size-3 bg-[#0a3a78] shadow-[0_0_0_3px_var(--v2-background-bg-base),0_0_0_5px_rgb(26_100_214/0.35)]":
          props.kind === "here",
        "size-2.5 bg-v2-text-text-muted shadow-[0_0_0_3px_var(--v2-background-bg-base)]": props.kind === "past",
        "size-2.5 border-[1.5px] border-dashed border-v2-text-text-faint bg-v2-background-bg-base": props.kind === "ahead",
        "size-2.5 border-[1.5px] border-v2-text-text-faint bg-v2-background-bg-base": props.kind === "branch",
      }}
    />
  )
}

function TreeRow(props: {
  row: Row
  rail: Rail
  current: boolean
  selected: boolean
  time: string
  onSelect: () => void
}) {
  const ctx = usePlugin()
  const node = () => props.row.node
  const depth = () => props.row.depth
  const line = "absolute w-0 border-s-[1.5px]"

  const kind = (): DotKind => {
    if (props.current) return "here"

    if (node().path === "ahead") return "ahead"

    if (node().path === "branch") return "branch"

    return "past"
  }

  // Newest first: the line up leads to newer checkpoints, the line down to older ones. Undone checkpoints and other
  // paths hang off solid history with a dashed line.
  const tone = () => (node().path === "current" ? "border-v2-border-border-strong" : "border-dashed border-v2-border-border-strong")

  return (
    <button
      type="button"
      role="option"
      aria-selected={props.selected}
      data-slot="checkpoints-row"
      data-path={node().path}
      class="group relative flex items-stretch min-h-[54px] pe-2.5 rounded-lg text-start cursor-pointer transition-colors"
      classList={{
        "bg-[#1a64d6]/10 shadow-[inset_0_0_0_1px_rgb(26_100_214/0.3)]": props.selected,
        "hover:bg-v2-overlay-simple-overlay-hover": !props.selected,
      }}
      style={{ "padding-inline-start": `${lane(depth()) + 16}px` }}
      onClick={() => props.onSelect()}
    >
      {/* The timeline: lines of the paths passing this row, this path's line in and out of the dot, the elbow a branch
          starts with, and the dot itself. */}
      <For each={props.rail.through}>
        {(level) => (
          <span
            aria-hidden="true"
            class={`${line} top-0 bottom-0 border-v2-border-border-strong`}
            style={{ "inset-inline-start": `${lane(level)}px` }}
          />
        )}
      </For>
      <Show when={props.rail.up}>
        <span
          aria-hidden="true"
          class={`${line} top-0 h-1/2 border-v2-border-border-strong`}
          classList={{ "border-dashed": node().path !== "current" || props.current }}
          style={{ "inset-inline-start": `${lane(depth())}px` }}
        />
      </Show>
      <Show when={props.rail.down}>
        <span
          aria-hidden="true"
          class={`${line} top-1/2 bottom-0 ${tone()}`}
          style={{ "inset-inline-start": `${lane(depth())}px` }}
        />
      </Show>
      {/* A branch's first checkpoint curves down into the path it split from, which is listed below it. */}
      <Show when={props.row.split && depth() > 0}>
        <span
          aria-hidden="true"
          class="absolute top-1/2 bottom-0 border-s-[1.5px] border-t-[1.5px] border-dashed border-v2-border-border-strong rounded-ss-[10px]"
          style={{ "inset-inline-start": `${lane(depth() - 1)}px`, width: `${INDENT}px` }}
        />
      </Show>
      <span
        class="absolute top-1/2 flex items-center justify-center -translate-y-1/2 -translate-x-1/2 rtl:translate-x-1/2"
        style={{ "inset-inline-start": `${lane(depth()) + 0.75}px` }}
      >
        <Dot kind={kind()} />
      </span>

      <span class="flex flex-1 min-w-0 flex-col justify-center gap-1 py-2">
        <span class="flex items-center gap-2 min-w-0">
          <span
            class="flex-1 min-w-0 truncate text-[13px]"
            classList={{
              "text-v2-text-text-base font-[500]": props.current,
              "text-v2-text-text-base": !props.current && node().path === "current",
              "text-v2-text-text-muted": node().path !== "current",
            }}
          >
            {node().title || ctx.t("checkpoints.untitled")}
          </span>
          <span class="shrink-0 text-[11px] tabular-nums text-v2-text-text-faint">{props.time}</span>
        </span>
        <span class="flex flex-wrap items-center gap-1.5 text-[11px] text-v2-text-text-faint">
          <Show when={props.current}>
            <span class="inline-flex items-center h-[18px] px-1.5 rounded-md bg-[#1a64d6]/15 font-[500] text-[color-mix(in_srgb,#1a64d6_85%,var(--v2-text-text-base))]">
              {ctx.t("checkpoints.here")}
            </span>
          </Show>
          <Show when={node().path === "ahead"}>
            <span class="inline-flex items-center h-[18px] px-1.5 rounded-md bg-v2-overlay-simple-overlay-hover text-v2-text-text-muted">
              {ctx.t("checkpoints.ahead")}
            </span>
          </Show>
          <Show when={props.row.split}>
            <span class="inline-flex items-center gap-1 h-[18px] px-1.5 rounded-md bg-v2-overlay-simple-overlay-hover text-v2-text-text-muted">
              <Icon name="branch-out" size="small" class="shrink-0" />
              {ctx.t("checkpoints.branch")}
            </span>
          </Show>
          <span class="inline-flex items-center gap-1">
            <Icon name="file-document" size="small" class="shrink-0" />
            {ctx.plural("checkpoints.files", node().files.length)}
          </span>
        </span>
      </span>
    </button>
  )
}

/** The selected checkpoint: what it changed, or how it differs from now, and the way to go there. */
function Details(props: { view: CheckpointView; node: Checkpoint.Node; onJump: () => void }) {
  const ctx = usePlugin()
  const [open, setOpen] = createSignal<string>()
  const here = () => props.view.current()?.key === props.node.key
  const blocked = () => !!props.view.working() || !!props.view.busy()

  const totals = () =>
    (props.view.diff() ?? []).reduce(
      (total, file) => ({ additions: total.additions + file.additions, deletions: total.deletions + file.deletions }),
      { additions: 0, deletions: 0 },
    )

  const modes: Mode[] = ["change", "now"]

  return (
    <div data-slot="checkpoints-details" class={card}>
      <div class="flex items-start gap-3">
        <div class="flex flex-1 min-w-0 flex-col gap-0.5">
          <span class={kicker}>{ctx.t(here() ? "checkpoints.details.current" : "checkpoints.details")}</span>
          <span class="text-14-medium text-v2-text-text-base break-words">
            {props.node.title || ctx.t("checkpoints.untitled")}
          </span>
        </div>
        <Show when={props.view.diff()}>
          <Counts additions={totals().additions} deletions={totals().deletions} />
        </Show>
      </div>
      <div role="tablist" class="flex p-0.5 rounded-lg bg-v2-overlay-simple-overlay-hover">
        <For each={modes}>
          {(mode) => (
            <button
              type="button"
              role="tab"
              aria-selected={props.view.mode() === mode}
              class="flex-1 h-7 px-2 rounded-md text-12-medium cursor-pointer transition-colors"
              classList={{
                "bg-v2-background-bg-base text-v2-text-text-base shadow-[0_1px_2px_rgb(0_0_0/0.08)]":
                  props.view.mode() === mode,
                "text-v2-text-text-muted hover:text-v2-text-text-base": props.view.mode() !== mode,
              }}
              onClick={() => props.view.setMode(mode)}
            >
              {ctx.t(`checkpoints.mode.${mode}`)}
            </button>
          )}
        </For>
      </div>
      <Switch>
        <Match when={props.view.diffFailed()}>
          <Note tone="danger" icon="warning">
            <span class="flex items-center gap-2">
              {ctx.t("checkpoints.diff.failed")}
              <button type="button" class={quiet} onClick={() => props.view.retryDiff()}>
                {ctx.t("checkpoints.retry")}
              </button>
            </span>
          </Note>
        </Match>
        <Match when={!props.view.diff()}>
          <span class="flex items-center gap-2 text-12-regular text-v2-text-text-muted">
            <Spinner />
            {ctx.t("checkpoints.diff.loading")}
          </span>
        </Match>
        <Match when={props.view.diff()?.length === 0}>
          <span class="text-12-regular text-v2-text-text-muted">
            {ctx.t(props.view.mode() === "now" ? "checkpoints.diff.same" : "checkpoints.diff.none")}
          </span>
        </Match>
        <Match when={props.view.diff()}>
          {(files) => (
            <div class="flex flex-col rounded-lg border border-v2-border-border-base overflow-hidden">
              <For each={files()}>
                {(file) => (
                  <FileRow
                    file={file}
                    open={open() === file.file}
                    onToggle={() => setOpen(open() === file.file ? undefined : file.file)}
                  />
                )}
              </For>
            </div>
          )}
        </Match>
      </Switch>
      <div class="flex flex-wrap items-center gap-2">
        <Show
          when={!here()}
          fallback={
            <span class="inline-flex items-center gap-1.5 text-12-medium text-[#1a64d6]">
              <Icon name="check" size="small" />
              {ctx.t("checkpoints.here.long")}
            </span>
          }
        >
          <button
            type="button"
            data-action="checkpoints-jump"
            class={primary}
            disabled={blocked()}
            onClick={() => props.onJump()}
          >
            <Busy when={props.view.busy() === "jump"}>
              <Icon name="outline-undo" size="small" />
            </Busy>
            {ctx.t("checkpoints.jump")}
          </button>
          <Show when={props.view.working()}>
            {(working) => (
              <span class="text-12-regular text-v2-text-text-muted">
                {ctx.t("checkpoints.working", { session: working().title })}
              </span>
            )}
          </Show>
        </Show>
      </div>
    </div>
  )
}

function FileRow(props: { file: FileDiff.Info; open: boolean; onToggle: () => void }) {
  return (
    <div class="border-b border-v2-border-border-base last:border-b-0">
      <button
        type="button"
        aria-expanded={props.open}
        class="flex w-full items-center gap-2 h-8 px-2.5 cursor-pointer text-start transition-colors hover:bg-v2-overlay-simple-overlay-hover"
        onClick={() => props.onToggle()}
      >
        <Icon
          name="fill-triangle-down"
          size="small"
          class="shrink-0 text-v2-text-text-faint transition-transform"
          classList={{ "-rotate-90": !props.open }}
        />
        <StatusChip status={props.file.status} />
        <span class="flex-1 min-w-0">
          <FilePath path={props.file.file} />
        </span>
        <Counts additions={props.file.additions} deletions={props.file.deletions} />
      </button>
      <Show when={props.open}>
        <div class="h-[420px] border-t border-v2-border-border-base">
          <div data-component="session-review-v2">
            <SessionReviewFilePreviewV2 file={props.file.file} diffStyle="unified" diff={props.file} />
          </div>
        </div>
      </Show>
    </div>
  )
}
