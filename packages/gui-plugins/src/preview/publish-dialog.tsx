// Publish from the preview: a compact form of the Publishing tool for the project on screen. Before the first publish it
// claims the address, while a deploy runs it shows the steps, and once live it shows the site. Custom domains, the
// deploy history and deleting the site stay in Tools › Publishing.

import { createSignal, For, Match, onCleanup, Show, Switch, type JSX } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import type { Publish } from "@opencode/schema/publish"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { Loader } from "@opencode/ui/loader"
import { ago, duration, stepState, STEPS, type StepState } from "../tools/contract"
import type { Problem, PublishState } from "./publish"

// The brand's navy, the logo's background.
const primary =
  "inline-flex items-center justify-center gap-2 h-8 px-3.5 rounded-lg bg-[#0a3a78] text-[#fff] text-[13px] font-medium cursor-pointer transition-colors hover:bg-[#082f62] disabled:opacity-50 disabled:cursor-default disabled:pointer-events-none"

const secondary =
  "inline-flex items-center justify-center gap-2 h-8 px-3 rounded-lg border border-v2-border-border-base bg-v2-background-bg-base text-[13px] font-medium text-v2-text-text-base cursor-pointer transition-colors hover:bg-v2-overlay-simple-overlay-hover disabled:opacity-50 disabled:cursor-default disabled:pointer-events-none"

const card = "flex flex-col gap-3 p-4 rounded-xl border border-v2-border-border-base/70 bg-v2-background-bg-layer-01"

export function PublishDialog(props: { publish: PublishState }) {
  const ctx = usePlugin()
  const publish = props.publish

  return (
    <Dialog class="w-[460px]" fit>
      <DialogHeader>
        <DialogTitleGroup title={ctx.t("publish.title")} />
      </DialogHeader>
      <DialogBody>
        <div data-component="preview-publish" class="flex flex-col gap-3 px-5 pb-5">
          <Show when={publish.error()}>
            {(error) => (
              <div class="flex items-start gap-2">
                <div class="flex-1 min-w-0">
                  <Failure problem={error()} />
                </div>
                <button
                  type="button"
                  aria-label={ctx.t("publish.dismiss")}
                  class="shrink-0 flex items-center justify-center size-6 rounded-md cursor-pointer text-v2-text-text-faint transition-colors hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base"
                  onClick={() => publish.dismissError()}
                >
                  <Icon name="close-small" size="small" />
                </button>
              </div>
            )}
          </Show>
          <Switch>
            <Match when={!publish.loaded()}>
              <Show when={!publish.error()}>
                <div
                  role="status"
                  aria-label={ctx.t("publish.loading")}
                  class="flex items-center justify-center py-10 text-v2-text-text-muted"
                >
                  <Loader width={24} height={24} />
                </div>
              </Show>
            </Match>
            <Match when={!publish.configured()}>
              <NotConfigured />
            </Match>
            <Match when={publish.running()} keyed>
              {(deploy) => <Running publish={publish} deploy={deploy} />}
            </Match>
            <Match when={publish.live() ? publish.site() : undefined}>
              {(site) => <Live publish={publish} site={site()} />}
            </Match>
            <Match when={true}>
              <Setup publish={publish} />
            </Match>
          </Switch>
          <Show when={publish.failed()}>
            {(deploy) => (
              <Note tone="danger">
                <span class="flex flex-col gap-0.5">
                  <span class="font-medium">{ctx.t("publish.lastFailed")}</span>
                  <Show when={deploy().error}>{(error) => <span>{error()}</span>}</Show>
                </span>
              </Note>
            )}
          </Show>
        </div>
      </DialogBody>
    </Dialog>
  )
}

function NotConfigured() {
  const ctx = usePlugin()

  return (
    <div class="flex flex-col items-center gap-3 px-6 py-8 rounded-xl border border-dashed border-v2-border-border-base text-center">
      <span class="flex items-center justify-center size-10 rounded-xl bg-v2-overlay-simple-overlay-hover text-v2-text-text-muted">
        <Icon name="cloud-upload" />
      </span>
      <div class="flex flex-col gap-1">
        <b class="text-14-medium text-v2-text-text-base">{ctx.t("publish.notConfigured.title")}</b>
        <span class="text-12-regular leading-[1.5] text-v2-text-text-muted">{ctx.t("publish.notConfigured.body")}</span>
      </div>
    </div>
  )
}

/** Before the site is live: the address to claim, what kind of app was found, and Publish. */
function Setup(props: { publish: PublishState }) {
  const ctx = usePlugin()
  const publish = props.publish
  const unsupported = () => publish.detected()?.reason
  const framework = () => publish.detected()?.framework ?? publish.detected()?.kind
  const availability = () => publish.availability()

  const ready = () =>
    !publish.busy() && !unsupported() && (publish.nameLocked() || availability().state === "available")

  const run = () => {
    if (ready()) void publish.publish()
  }

  const takenReason = () => {
    const current = availability()

    return (current.state === "taken" && current.reason) || ctx.t("publish.taken")
  }

  return (
    <div class={card}>
      <span class="text-[13px] text-v2-text-text-muted">{ctx.t("publish.setup.body")}</span>
      <label class="flex flex-col gap-1.5">
        <span class="text-12-medium text-v2-text-text-muted">{ctx.t("publish.address")}</span>
        <span
          class="flex items-center h-9 rounded-lg border bg-v2-background-bg-base transition-colors focus-within:border-v2-border-border-strong"
          classList={{
            "border-v2-border-border-base": availability().state !== "taken",
            "border-[#c4483e]/60": availability().state === "taken",
            "opacity-70": publish.nameLocked(),
          }}
        >
          <input
            data-slot="preview-publish-name"
            value={publish.nameDraft()}
            disabled={publish.nameLocked()}
            spellcheck={false}
            autocomplete="off"
            autofocus
            aria-label={ctx.t("publish.address")}
            placeholder={ctx.t("publish.address.placeholder")}
            class="flex-1 min-w-0 h-full bg-transparent ps-3 pe-0.5 font-mono text-[13px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint disabled:cursor-default"
            onInput={(event) => publish.setName(event.currentTarget.value)}
            onKeyDown={(event) => event.key === "Enter" && run()}
          />
          <span class="shrink-0 pe-2 font-mono text-[13px] text-v2-text-text-muted select-none">
            <Show when={publish.zone()}>{(zone) => `.${zone()}`}</Show>
          </span>
          <span class="shrink-0 flex items-center justify-center w-8 h-full border-s border-v2-border-border-base">
            <Switch>
              <Match when={availability().state === "checking"}>
                <Loader width={14} height={14} />
              </Match>
              <Match when={availability().state === "available"}>
                <Icon name="check" size="small" class="text-[#3f8f6a]" />
              </Match>
              <Match when={availability().state === "taken"}>
                <Icon name="close-small" size="small" class="text-[#c4483e]" />
              </Match>
              <Match when={publish.nameLocked()}>
                <Icon name="lock" size="small" class="text-v2-text-text-faint" />
              </Match>
            </Switch>
          </span>
        </span>
        <span aria-live="polite" class="min-h-4 text-[12px] leading-[16px]">
          <Switch>
            <Match when={availability().state === "available"}>
              <span class="text-[#3f8f6a]">{ctx.t("publish.available")}</span>
            </Match>
            <Match when={availability().state === "taken"}>
              <span class="text-[#c4483e]">{takenReason()}</span>
            </Match>
            <Match when={availability().state === "checking"}>
              <span class="text-v2-text-text-faint">{ctx.t("publish.checking")}</span>
            </Match>
            <Match when={publish.nameLocked()}>
              <span class="text-v2-text-text-faint">{ctx.t("publish.address.locked")}</span>
            </Match>
          </Switch>
        </span>
      </label>

      <div class="flex items-center gap-2">
        <div class="flex-1 min-w-0">
          <Show
            when={unsupported()}
            fallback={
              <Show when={framework()}>
                {(name) => (
                  <div class="flex items-center gap-2 text-12-regular text-v2-text-text-muted">
                    {ctx.t("publish.detected")}
                    <span class="inline-flex items-center gap-1 h-[22px] px-2 rounded-md bg-[#1a64d6]/15 font-medium text-[color-mix(in_srgb,#1a64d6_85%,var(--v2-text-text-base))] truncate">
                      <Icon name="code" size="small" class="shrink-0" />
                      {name()}
                    </span>
                  </div>
                )}
              </Show>
            }
          >
            {(reason) => <Note tone="warning">{ctx.t("publish.unsupported", { reason: reason() })}</Note>}
          </Show>
        </div>
        <button
          type="button"
          data-action="preview-publish-run"
          class={`${primary} h-9 px-4 shrink-0`}
          disabled={!ready()}
          onClick={run}
        >
          <Show when={publish.busy() === "publish"} fallback={<Icon name="cloud-upload" size="small" />}>
            <Loader width={14} height={14} style={{ color: "inherit" }} />
          </Show>
          {ctx.t("publish.publish")}
        </button>
      </div>
    </div>
  )
}

/** A deploy in progress: the steps, how long it has run, and Cancel. */
function Running(props: { publish: PublishState; deploy: Publish.Deploy }) {
  const ctx = usePlugin()

  // The elapsed time, a second at a time while the deploy runs.
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1000)

  onCleanup(() => clearInterval(timer))

  return (
    <div class={card}>
      <div class="flex items-center gap-3">
        <Loader width={14} height={14} />
        <div class="flex flex-1 min-w-0 flex-col">
          <span class="text-14-medium text-v2-text-text-base">{ctx.t("publish.publishing")}</span>
          <span class="text-12-regular tabular-nums text-v2-text-text-muted">
            {ctx.t("publish.elapsed", { time: duration(props.deploy, now()) })}
          </span>
        </div>
        <button
          type="button"
          data-action="preview-publish-cancel"
          class={`${secondary} h-7 px-2.5`}
          disabled={!!props.publish.busy()}
          onClick={() => void props.publish.cancel()}
        >
          <Show when={props.publish.busy() === "cancel"} fallback={<Icon name="stop" size="small" />}>
            <Loader width={14} height={14} style={{ color: "inherit" }} />
          </Show>
          {ctx.t("publish.cancel")}
        </button>
      </div>

      <ol class="flex items-start m-0 p-0 list-none">
        <For each={STEPS}>
          {(step, index) => (
            <li class="relative flex flex-1 min-w-0 flex-col items-center gap-1.5">
              <Show when={index() > 0}>
                <span
                  aria-hidden="true"
                  class="absolute top-[11px] end-[calc(50%+14px)] w-[calc(100%-28px)] h-[1.5px] rounded-full"
                  classList={{
                    "bg-[#1a64d6]/60": stepState(props.deploy, step) !== "todo",
                    "bg-v2-border-border-base": stepState(props.deploy, step) === "todo",
                  }}
                />
              </Show>
              <StepDot state={stepState(props.deploy, step)} />
              <span
                class="max-w-full truncate text-[11px]"
                classList={{
                  "text-v2-text-text-base font-medium": stepState(props.deploy, step) === "active",
                  "text-v2-text-text-muted": stepState(props.deploy, step) === "done",
                  "text-v2-text-text-faint": stepState(props.deploy, step) === "todo",
                  "text-[#c4483e]": stepState(props.deploy, step) === "failed",
                }}
              >
                {ctx.t(`publish.steps.${step}`)}
              </span>
            </li>
          )}
        </For>
      </ol>

      <span class="text-12-regular text-v2-text-text-faint">{ctx.t("publish.continues")}</span>
    </div>
  )
}

function StepDot(props: { state: StepState }) {
  return (
    <span
      class="relative z-[1] flex items-center justify-center size-6 rounded-full"
      classList={{
        "bg-[#0a3a78] text-[#fff]": props.state === "done",
        "bg-[#1a64d6]/15 text-[#1a64d6] shadow-[0_0_0_1px_rgb(26_100_214/0.35)]": props.state === "active",
        "bg-v2-overlay-simple-overlay-hover text-v2-text-text-faint": props.state === "todo",
        "bg-[#c4483e] text-[#fff]": props.state === "failed",
      }}
    >
      <Switch>
        <Match when={props.state === "done"}>
          <Icon name="check-small" size="small" />
        </Match>
        <Match when={props.state === "active"}>
          <Loader width={14} height={14} style={{ color: "inherit" }} />
        </Match>
        <Match when={props.state === "failed"}>
          <Icon name="close-small" size="small" />
        </Match>
        <Match when={props.state === "todo"}>
          <span class="size-1.5 rounded-full bg-current" />
        </Match>
      </Switch>
    </span>
  )
}

/** The live site: the address, when it went live, and Republish / Open / Copy. */
function Live(props: { publish: PublishState; site: Publish.Site }) {
  const ctx = usePlugin()
  const address = () => props.publish.address() ?? props.site.url

  // The clock "Published … ago" reads, a minute at a time.
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 60_000)

  onCleanup(() => clearInterval(timer))

  // `ctx.system.copy` falls back where the Clipboard API is missing, as on plain HTTP LAN origins.
  const copy = () =>
    ctx.system.copy(address()).then(
      () => ctx.toast.show({ variant: "success", title: ctx.t("publish.copied"), description: address() }),
      () => ctx.toast.show({ variant: "error", title: ctx.t("publish.copy.failed") }),
    )

  return (
    <div class={card}>
      <div class="flex flex-col gap-1 min-w-0">
        <span class="inline-flex items-center gap-1.5 self-start h-5 px-1.5 rounded-md bg-[#3f8f6a]/12 text-[11px] font-medium text-[#3f8f6a]">
          <span class="size-1.5 rounded-full bg-current" />
          {ctx.t("publish.live")}
        </span>
        <button
          type="button"
          data-action="preview-publish-address"
          title={address()}
          class="self-start max-w-full truncate text-start text-14-medium text-v2-text-text-base cursor-pointer hover:underline"
          onClick={() => ctx.system.openExternal(address())}
        >
          {address().replace(/^https:\/\//, "")}
        </button>
        <Show when={props.site.publishedAt}>
          {(time) => (
            <span class="text-12-regular text-v2-text-text-muted">
              {ctx.t("publish.publishedAgo", { time: ago(time(), now(), ctx.locale.locale()) })}
            </span>
          )}
        </Show>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-action="preview-publish-republish"
          class={primary}
          disabled={!!props.publish.busy()}
          onClick={() => void props.publish.publish()}
        >
          <Show when={props.publish.busy() === "publish"} fallback={<Icon name="cloud-upload" size="small" />}>
            <Loader width={14} height={14} style={{ color: "inherit" }} />
          </Show>
          {ctx.t("publish.republish")}
        </button>
        <button
          type="button"
          data-action="preview-publish-open"
          class={secondary}
          onClick={() => ctx.system.openExternal(address())}
        >
          <Icon name="square-arrow-top-right" size="small" />
          {ctx.t("publish.open")}
        </button>
        <button type="button" data-action="preview-publish-copy" class={secondary} onClick={() => void copy()}>
          <Icon name="outline-copy" size="small" />
          {ctx.t("publish.copy")}
        </button>
      </div>
    </div>
  )
}

/** A refused call: what kind of refusal it was in plain words, then the server's own sentence. */
function Failure(props: { problem: Problem }) {
  const ctx = usePlugin()
  const title = () => ctx.t(`publish.failed.${props.problem.kind}`)

  return (
    <Note tone="danger">
      <span class="flex flex-col gap-0.5">
        <span class="font-medium">{title()}</span>
        <Show when={props.problem.message && props.problem.message !== title()}>
          <span>{props.problem.message}</span>
        </Show>
      </span>
    </Note>
  )
}

function Note(props: { tone: "danger" | "warning"; children: JSX.Element }) {
  return (
    <div
      class="flex items-start gap-2 px-3 py-2.5 rounded-lg text-12-regular"
      classList={{
        "bg-v2-state-bg-danger text-v2-state-fg-danger": props.tone === "danger",
        "bg-v2-state-bg-warning text-v2-state-fg-warning": props.tone === "warning",
      }}
    >
      <Icon name="warning" size="small" class="shrink-0 mt-px" />
      <div class="flex-1 min-w-0 break-words">{props.children}</div>
    </div>
  )
}
