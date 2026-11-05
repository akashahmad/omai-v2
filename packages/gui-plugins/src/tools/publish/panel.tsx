// The Publishing tool: puts the project's app on the web at `<name>.<zone>`. Before the first publish it picks the
// name; while a deploy runs it shows the steps and the log; once live it shows the site, the deploys so far, and how to
// delete it.

import { createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { createKeyed, createLatest, usePlugin } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { Tooltip } from "@opencode/ui/tooltip"
import type { Publish } from "@opencode/schema/publish"
import { pill } from "../contract"
import { Busy, card, Failure, iconButton, kicker, Note, primary, quiet, secondary, Spinner } from "../ui"
import { ago, duration, stepState, STEPS, type StepState } from "./model"
import type { PublishView } from "./view"

export function PublishPanel(props: { view: PublishView; onDomains: () => void }) {
  const ctx = usePlugin()

  return (
    <div data-component="tools-publish" class="@container flex flex-col gap-4 pb-10">
      <div class="flex items-start gap-3">
        <div class="flex flex-1 min-w-0 flex-col gap-1">
          <span class="text-16-medium text-v2-text-text-base">{ctx.t("publish.title")}</span>
          <div class="text-[13px] text-v2-text-text-muted">{ctx.t("publish.description")}</div>
        </div>
        <Tooltip value={ctx.t("publish.refresh")} placement="left">
          <button
            type="button"
            data-action="publish-refresh"
            aria-label={ctx.t("publish.refresh")}
            class={`${iconButton} size-8`}
            onClick={() => void props.view.refresh()}
          >
            <Icon name="refresh" size="small" />
          </button>
        </Tooltip>
      </div>
      {/* A session switch brings another view without remounting the panel; its body starts afresh with it. */}
      <Show when={props.view} keyed>
        {(view) => <Body view={view} onDomains={props.onDomains} />}
      </Show>
    </div>
  )
}

function Body(props: { view: PublishView; onDomains: () => void }) {
  const ctx = usePlugin()
  const view = props.view

  // The clock relative times read, a minute at a time.
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 60_000)

  onCleanup(() => clearInterval(timer))

  return (
    <Show
      when={view.loaded()}
      fallback={
        <Show
          when={view.error()}
          fallback={
            <div class="flex items-center justify-center py-16 text-v2-text-text-muted">
              <Spinner large />
            </div>
          }
        >
          {(error) => <Failure problem={error()} />}
        </Show>
      }
    >
      <Show when={view.error()}>
        {(error) => (
          <div class="flex items-start gap-2">
            <div class="flex-1 min-w-0">
              <Failure problem={error()} />
            </div>
            <button
              type="button"
              aria-label={ctx.t("publish.dismiss")}
              class={iconButton}
              onClick={() => view.dismissError()}
            >
              <Icon name="close-small" size="small" />
            </button>
          </div>
        )}
      </Show>
      <Switch>
        <Match when={!view.configured()}>
          <NotConfigured />
        </Match>
        <Match when={view.configured()}>
          <Show when={view.running()} keyed>
            {(running) => <Running view={view} deploy={running} />}
          </Show>
          <Show when={!view.published() && !view.running()}>
            <Setup view={view} />
          </Show>
          <Show when={view.published() ? view.site() : undefined}>
            {(site) => <Live view={view} site={site()} now={now()} onDomains={props.onDomains} />}
          </Show>
          <Show when={view.history().length > 0}>
            <History view={view} now={now()} />
          </Show>
          <Show when={view.site()?.name} keyed>
            {(name) => <Danger view={view} name={name} />}
          </Show>
        </Match>
      </Switch>
    </Show>
  )
}

function NotConfigured() {
  const ctx = usePlugin()

  return (
    <div
      data-slot="publish-not-configured"
      class="flex flex-col items-center gap-3 px-6 py-10 rounded-xl border border-dashed border-v2-border-border-base text-center"
    >
      <span class="flex items-center justify-center size-12 rounded-xl bg-v2-overlay-simple-overlay-hover text-v2-text-text-muted">
        <Icon name="cloud-upload" />
      </span>
      <div class="flex flex-col gap-1 max-w-[340px]">
        <b class="text-14-medium text-v2-text-text-base">{ctx.t("publish.notConfigured.title")}</b>
        <span class="text-12-regular leading-[1.5] text-v2-text-text-muted">{ctx.t("publish.notConfigured.body")}</span>
      </div>
    </div>
  )
}

/** Before the first publish: the address to claim, what kind of app was found, and the Publish button. */
function Setup(props: { view: PublishView }) {
  const ctx = usePlugin()
  const view = props.view
  const unsupported = () => view.detected()?.reason
  const framework = () => view.detected()?.framework ?? view.detected()?.kind

  const ready = () => !view.busy() && !unsupported() && (view.nameLocked() || view.availability().state === "available")

  const publish = () => {
    if (ready()) void view.publish()
  }

  const takenReason = () => {
    const availability = view.availability()

    return (availability.state === "taken" && availability.reason) || ctx.t("publish.taken")
  }

  return (
    <div data-slot="publish-setup" class={card}>
      <div class="flex items-start gap-3">
        <span class="shrink-0 flex items-center justify-center size-10 rounded-xl bg-[#0a3a78] text-[#fff]">
          <Icon name="cloud-upload" />
        </span>
        <div class="flex flex-1 min-w-0 flex-col gap-0.5">
          <span class="text-14-medium text-v2-text-text-base">{ctx.t("publish.setup.title")}</span>
          <span class="text-12-regular leading-[1.5] text-v2-text-text-muted">{ctx.t("publish.setup.body")}</span>
        </div>
      </div>

      <label class="flex flex-col gap-1.5">
        <span class={kicker}>{ctx.t("publish.address")}</span>
        <span
          class="flex items-center h-9 rounded-lg border bg-v2-background-bg-base transition-colors focus-within:border-v2-border-border-strong"
          classList={{
            "border-v2-border-border-base": view.availability().state !== "taken",
            "border-[#c4483e]/60": view.availability().state === "taken",
            "opacity-70": view.nameLocked(),
          }}
        >
          <span class="ps-3 text-[13px] text-v2-text-text-faint select-none">https://</span>
          <input
            data-slot="publish-name"
            value={view.nameDraft()}
            disabled={view.nameLocked()}
            spellcheck={false}
            autocomplete="off"
            aria-label={ctx.t("publish.address")}
            placeholder={ctx.t("publish.address.placeholder")}
            class="flex-1 min-w-0 h-full bg-transparent px-0.5 font-mono text-[13px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint disabled:cursor-default"
            onInput={(event) => view.setName(event.currentTarget.value)}
            onKeyDown={(event) => event.key === "Enter" && publish()}
          />
          <span class="shrink-0 pe-2 font-mono text-[13px] text-v2-text-text-muted select-none">
            <Show when={view.zone()}>{(zone) => `.${zone()}`}</Show>
          </span>
          <span class="shrink-0 flex items-center justify-center w-8 h-full border-s border-v2-border-border-base">
            <Switch>
              <Match when={view.availability().state === "checking"}>
                <Spinner />
              </Match>
              <Match when={view.availability().state === "available"}>
                <Icon name="check" size="small" class="text-[#3f8f6a]" />
              </Match>
              <Match when={view.availability().state === "taken"}>
                <Icon name="close-small" size="small" class="text-[#c4483e]" />
              </Match>
              <Match when={view.nameLocked()}>
                <Icon name="lock" size="small" class="text-v2-text-text-faint" />
              </Match>
            </Switch>
          </span>
        </span>
        <span aria-live="polite" class="min-h-4 text-[12px] leading-[16px]">
          <Switch>
            <Match when={view.availability().state === "available"}>
              <span class="text-[#3f8f6a]">{ctx.t("publish.available")}</span>
            </Match>
            <Match when={view.availability().state === "taken"}>
              <span class="text-[#c4483e]">{takenReason()}</span>
            </Match>
            <Match when={view.availability().state === "checking"}>
              <span class="text-v2-text-text-faint">{ctx.t("publish.checking")}</span>
            </Match>
            <Match when={view.nameLocked()}>
              <span class="text-v2-text-text-faint">{ctx.t("publish.address.locked")}</span>
            </Match>
          </Switch>
        </span>
      </label>

      <Show
        when={unsupported()}
        fallback={
          <Show when={framework()}>
            {(name) => (
              <div class="flex items-center gap-2 text-12-regular text-v2-text-text-muted">
                {ctx.t("publish.detected")}
                <span class="inline-flex items-center gap-1 h-[22px] px-2 rounded-md bg-[#1a64d6]/15 font-medium text-[color-mix(in_srgb,#1a64d6_85%,var(--v2-text-text-base))]">
                  <Icon name="code" size="small" class="shrink-0" />
                  {name()}
                </span>
              </div>
            )}
          </Show>
        }
      >
        {(reason) => (
          <Note tone="warning" icon="warning">
            {ctx.t("publish.unsupported", { reason: reason() })}
          </Note>
        )}
      </Show>

      <div class="flex items-center gap-2">
        <button
          type="button"
          data-action="publish-run"
          class={`${primary} h-9 px-4`}
          disabled={!ready()}
          onClick={publish}
        >
          <Busy when={view.busy() === "publish"}>
            <Icon name="cloud-upload" size="small" />
          </Busy>
          {ctx.t("publish.publish")}
        </button>
      </div>
    </div>
  )
}

/** A deploy in progress: the steps, how long it has run, its log on demand, and Cancel. */
function Running(props: { view: PublishView; deploy: Publish.Deploy }) {
  const ctx = usePlugin()
  const [open, setOpen] = createSignal(false)

  // The elapsed time, a second at a time while the deploy runs.
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1000)

  onCleanup(() => clearInterval(timer))

  return (
    <div data-slot="publish-running" class={card}>
      <div class="flex items-center gap-3">
        <Spinner />
        <div class="flex flex-1 min-w-0 flex-col">
          <span class="text-14-medium text-v2-text-text-base">{ctx.t("publish.publishing")}</span>
          <span class="text-12-regular tabular-nums text-v2-text-text-muted">
            {ctx.t("publish.elapsed", { time: duration(props.deploy, now()) })}
          </span>
        </div>
        <button
          type="button"
          data-action="publish-cancel"
          class={`${secondary} h-7 px-2.5`}
          disabled={!!props.view.busy()}
          onClick={() => void props.view.cancel()}
        >
          <Busy when={props.view.busy() === "cancel"}>
            <Icon name="stop" size="small" />
          </Busy>
          {ctx.t("publish.cancel")}
        </button>
      </div>

      <ol class="flex items-start">
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

      <div class="flex flex-col gap-2">
        <button type="button" aria-expanded={open()} class={`${quiet} self-start`} onClick={() => setOpen(!open())}>
          <Icon
            name="fill-triangle-down"
            size="small"
            class="transition-transform"
            classList={{ "-rotate-90": !open() }}
          />
          {ctx.t(open() ? "publish.log.hide" : "publish.log.show")}
        </button>
        <Show when={open()}>
          <LogText text={props.view.log()} follow />
        </Show>
      </div>
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
          <Spinner />
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

/** A deploy's log. `follow` keeps the newest line in sight as the log grows. */
function LogText(props: { text: string | undefined; follow?: boolean }) {
  const ctx = usePlugin()
  const [element, setElement] = createSignal<HTMLPreElement>()

  // Scrolls the log element to its end each time a running deploy writes to it.
  createKeyed(
    () => (props.follow ? element() && props.text : undefined),
    () => {
      const target = element()

      if (target) target.scrollTop = target.scrollHeight
    },
  )

  return (
    <Show
      when={props.text !== undefined}
      fallback={
        <span class="flex items-center gap-2 text-12-regular text-v2-text-text-muted">
          <Spinner />
          {ctx.t("publish.log.loading")}
        </span>
      }
    >
      <pre
        ref={setElement}
        data-scrollable
        class="max-h-[280px] min-h-0 overflow-auto m-0 p-3 rounded-lg bg-v2-background-bg-base border border-v2-border-border-base font-mono text-[12px] leading-[18px] text-v2-text-text-muted whitespace-pre-wrap break-words"
      >
        {props.text || ctx.t("publish.log.empty")}
      </pre>
    </Show>
  )
}

/** The live site: the preview's screenshot, the address, when it went live, and Republish / Open / Copy. */
function Live(props: { view: PublishView; site: Publish.Site; now: number; onDomains: () => void }) {
  const ctx = usePlugin()
  const address = () => props.view.address() ?? props.site.url
  const urls: string[] = []

  onCleanup(() => urls.splice(0).forEach((url) => URL.revokeObjectURL(url)))

  // The preview's latest screenshot; read again after each publish. None when the preview never ran.
  const thumbnail = createLatest(
    () => `${props.site.name}\u0000${props.site.publishedAt ?? 0}`,
    (_, signal) =>
      props.view.thumbnail(signal).then(
        (bytes) => {
          const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "image/webp" }))
          urls.push(url)

          return url
        },
        () => undefined,
      ),
  )

  const copy = () =>
    ctx.system.copy(address()).then(
      () => ctx.toast.show({ variant: "success", title: ctx.t("publish.copied"), description: address() }),
      () => ctx.toast.show({ variant: "error", title: ctx.t("publish.copy.failed") }),
    )

  return (
    <div
      data-slot="publish-live"
      class="flex flex-col overflow-hidden rounded-xl border border-v2-border-border-base/70 bg-v2-background-bg-layer-01 shadow-[0_1px_2px_rgb(0_0_0/0.04)]"
    >
      <Show when={thumbnail.latest}>
        {(src) => (
          <button
            type="button"
            aria-label={ctx.t("publish.open")}
            class="relative block h-36 w-full overflow-hidden border-b border-v2-border-border-base bg-v2-background-bg-base cursor-pointer"
            onClick={() => ctx.system.openExternal(address())}
          >
            <img src={src()} alt="" decoding="async" class="absolute inset-0 size-full object-cover object-top" />
          </button>
        )}
      </Show>
      <div class="flex flex-col gap-4 p-5">
        <div class="flex items-start gap-3">
          <div class="flex flex-1 min-w-0 flex-col gap-1">
            <span class="inline-flex items-center gap-1.5 self-start h-5 px-1.5 rounded-md bg-[#3f8f6a]/12 text-[11px] font-medium text-[#3f8f6a]">
              <span class="size-1.5 rounded-full bg-current" />
              {ctx.t("publish.live")}
            </span>
            <button
              type="button"
              data-action="publish-open-address"
              title={address()}
              class="self-start max-w-full truncate text-start text-14-medium text-v2-text-text-base cursor-pointer hover:underline"
              onClick={() => ctx.system.openExternal(address())}
            >
              {address().replace(/^https:\/\//, "")}
            </button>
            <Show when={props.site.publishedAt}>
              {(time) => (
                <span class="text-12-regular text-v2-text-text-muted">
                  {ctx.t("publish.publishedAgo", { time: ago(time(), props.now, ctx.locale.locale()) })}
                </span>
              )}
            </Show>
            <Show when={props.view.primary()}>
              {(domain) => (
                <PrimaryLine
                  domain={domain()}
                  subdomain={`${props.site.name}.${props.site.zone}`}
                  status={ctx.t(`domains.status.${pill(domain())}`)}
                  redirects={ctx.t("publish.domain.redirects", { host: `${props.site.name}.${props.site.zone}` })}
                />
              )}
            </Show>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-action="publish-republish"
            class={primary}
            disabled={!!props.view.busy() || !!props.view.running()}
            onClick={() => void props.view.publish()}
          >
            <Busy when={props.view.busy() === "publish"}>
              <Icon name="cloud-upload" size="small" />
            </Busy>
            {ctx.t("publish.republish")}
          </button>
          <button
            type="button"
            data-action="publish-open"
            class={secondary}
            onClick={() => ctx.system.openExternal(address())}
          >
            <Icon name="square-arrow-top-right" size="small" />
            {ctx.t("publish.open")}
          </button>
          <button type="button" data-action="publish-copy" class={secondary} onClick={() => void copy()}>
            <Icon name="outline-copy" size="small" />
            {ctx.t("publish.copy")}
          </button>
        </div>
      </div>
      <DomainsLink
        title={ctx.t(props.view.primary() ? "publish.domain.manage" : "publish.domain.add")}
        hint={props.view.primary() ? undefined : ctx.t("publish.domain.addHint")}
        onClick={props.onDomains}
      />
    </div>
  )
}

/**
 * The primary custom domain under the live address: once active the address above is the domain, and the platform
 * address redirects to it; before that, the domain and why it doesn't serve visitors yet.
 */
function PrimaryLine(props: { domain: Publish.Domain; subdomain: string; status: string; redirects: string }) {
  return (
    <Show
      when={props.domain.status === "active"}
      fallback={
        <span data-slot="publish-primary" class="flex min-w-0 items-center gap-1.5 text-12-regular text-v2-text-text-muted">
          <span
            class="size-1.5 shrink-0 rounded-full"
            classList={{
              "bg-v2-state-fg-danger": props.domain.status === "error",
              "bg-v2-state-fg-warning": props.domain.status !== "error",
            }}
          />
          <span class="truncate font-medium text-v2-text-text-base">{props.domain.hostname}</span>
          <span class="shrink-0">· {props.status}</span>
        </span>
      }
    >
      <span data-slot="publish-primary" class="truncate text-12-regular text-v2-text-text-muted">
        {props.redirects}
      </span>
    </Show>
  )
}

/** The way from the live site to its custom domains. */
function DomainsLink(props: { title: string; hint?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      data-action="publish-domains"
      class="group flex w-full items-center gap-3 border-t border-v2-border-border-base px-5 py-3 text-start cursor-pointer transition-colors hover:bg-v2-overlay-simple-overlay-hover"
      onClick={() => props.onClick()}
    >
      <span class="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[#1a64d6]/12 text-[#1a64d6]">
        <Icon name="globe" size="small" />
      </span>
      <span class="flex min-w-0 flex-1 flex-col">
        <span class="text-[13px] font-medium text-v2-text-text-base">{props.title}</span>
        <Show when={props.hint}>
          {(hint) => <span class="truncate text-12-regular text-v2-text-text-muted">{hint()}</span>}
        </Show>
      </span>
      <Icon
        name="outline-chevron-right"
        size="small"
        class="shrink-0 text-v2-icon-icon-muted transition-transform group-hover:translate-x-0.5 rtl:rotate-180"
      />
    </button>
  )
}

/** The last deploys, newest first: how each ended, when, how long it took, and why it failed. */
function History(props: { view: PublishView; now: number }) {
  const ctx = usePlugin()

  return (
    <div data-slot="publish-history" class={card}>
      <span class={kicker}>{ctx.t("publish.history")}</span>
      <div class="flex flex-col -mx-2">
        <For each={props.view.history()}>
          {(deploy) => <DeployRow view={props.view} deploy={deploy} now={props.now} />}
        </For>
      </div>
    </div>
  )
}

function DeployRow(props: { view: PublishView; deploy: Publish.Deploy; now: number }) {
  const ctx = usePlugin()
  const open = () => props.view.opened()?.id === props.deploy.id

  const ask = async () => {
    if (await props.view.askAI(props.deploy)) ctx.toast.show({ variant: "success", title: ctx.t("publish.askAI.sent") })
  }

  return (
    <div
      data-slot="publish-deploy"
      class="flex flex-col gap-2 px-2 py-2.5 rounded-lg border-b border-v2-border-border-base/60 last:border-b-0"
    >
      <div class="flex items-center gap-2 min-w-0">
        <span
          class="shrink-0 inline-flex items-center gap-1 h-5 px-1.5 rounded-md text-[11px] font-medium"
          classList={{
            "bg-[#3f8f6a]/12 text-[#3f8f6a]": props.deploy.status === "live",
            "bg-[#c4483e]/12 text-[#c4483e]": props.deploy.status === "failed",
            "bg-v2-overlay-simple-overlay-hover text-v2-text-text-muted":
              props.deploy.status === "cancelled" || props.deploy.status === "running",
          }}
        >
          {ctx.t(`publish.status.${props.deploy.status}`)}
        </span>
        <span class="flex-1 min-w-0 truncate text-[13px] text-v2-text-text-base">
          {ago(props.deploy.startedAt, props.now, ctx.locale.locale())}
        </span>
        <Show when={props.deploy.finishedAt}>
          <span class="shrink-0 font-mono text-[11px] tabular-nums text-v2-text-text-faint">
            {duration(props.deploy)}
          </span>
        </Show>
      </div>
      <Show when={props.deploy.error}>
        {(error) => <span class="text-12-regular text-[#c4483e] break-words">{error()}</span>}
      </Show>
      <div class="flex flex-wrap items-center gap-1 -ms-1.5">
        <button type="button" aria-expanded={open()} class={quiet} onClick={() => props.view.openLog(props.deploy.id)}>
          <Icon
            name="fill-triangle-down"
            size="small"
            class="transition-transform"
            classList={{ "-rotate-90": !open() }}
          />
          {ctx.t(open() ? "publish.hideLog" : "publish.viewLog")}
        </button>
        <Show when={props.deploy.status === "failed"}>
          <button
            type="button"
            data-action="publish-ask-ai"
            class={quiet}
            disabled={!!props.view.busy()}
            onClick={() => void ask()}
          >
            <Busy when={props.view.busy() === "ask"}>
              <Icon name="outline-brain" size="small" />
            </Busy>
            {ctx.t("publish.askAI")}
          </button>
        </Show>
      </div>
      <Show when={open()}>
        <LogText text={props.view.opened()?.text} />
      </Show>
    </div>
  )
}

/** Deleting the site, behind a dialog that asks for its name. */
function Danger(props: { view: PublishView; name: string }) {
  const ctx = usePlugin()

  // The dialog lives in the host's dialog layer and outlives this card once the site is gone, so it gets the name as a
  // plain string. An earlier failure belongs to another action and is cleared rather than shown in the dialog.
  const remove = () => {
    const name = props.name
    props.view.dismissError()
    ctx.dialogs.open((dialog) => <DeleteDialog view={props.view} name={name} onClose={dialog.close} />)
  }

  return (
    <div
      data-slot="publish-danger"
      class="flex flex-col gap-3 p-5 rounded-xl border border-[#c4483e]/30 bg-[#c4483e]/[0.03]"
    >
      <span class={`${kicker} text-[#c4483e]`}>{ctx.t("publish.danger")}</span>
      <div class="flex flex-wrap items-center gap-3">
        <span class="flex-1 min-w-[200px] text-12-regular leading-[1.5] text-v2-text-text-muted">
          {ctx.t("publish.danger.body")}
        </span>
        <button
          type="button"
          data-action="publish-delete"
          class="inline-flex items-center justify-center gap-2 h-8 px-3 rounded-lg border border-[#c4483e]/40 text-[13px] font-medium text-[#c4483e] cursor-pointer transition-colors hover:bg-[#c4483e]/10 disabled:opacity-50 disabled:cursor-default disabled:pointer-events-none"
          disabled={!!props.view.busy()}
          onClick={remove}
        >
          <Icon name="trash" size="small" />
          {ctx.t("publish.delete.title")}
        </button>
      </div>
    </div>
  )
}

function DeleteDialog(props: { view: PublishView; name: string; onClose: () => void }) {
  const ctx = usePlugin()
  const [typed, setTyped] = createSignal("")
  const matches = () => typed().trim() === props.name

  const submit = async () => {
    if (!matches() || props.view.busy()) return

    if (!(await props.view.remove(typed().trim()))) return
    ctx.toast.show({ variant: "success", title: ctx.t("publish.delete.done", { name: props.name }) })
    props.onClose()
  }

  return (
    <Dialog class="w-[440px]">
      <DialogHeader>
        <DialogTitleGroup title={ctx.t("publish.delete.title")} />
      </DialogHeader>
      <DialogBody>
        <form
          class="flex flex-col gap-3 pb-1"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <p class="text-[13px] leading-[1.5] text-v2-text-text-muted">
            {ctx.t("publish.delete.body", { name: props.name })}
          </p>
          <label class="flex flex-col gap-1.5">
            <span class="text-12-medium text-v2-text-text-muted">
              {ctx.t("publish.delete.confirm", { name: props.name })}
            </span>
            <input
              data-slot="publish-delete-confirm"
              value={typed()}
              autofocus
              spellcheck={false}
              autocomplete="off"
              placeholder={props.name}
              class="h-9 px-3 rounded-lg border border-v2-border-border-base bg-transparent font-mono text-[13px] text-v2-text-text-base outline-none focus:border-v2-border-border-strong placeholder:text-v2-text-text-faint"
              onInput={(event) => setTyped(event.currentTarget.value)}
            />
          </label>
          <Show when={props.view.error()}>{(error) => <Failure problem={error()} />}</Show>
          <div class="flex justify-end gap-2 pt-1">
            <Button type="button" size="small" variant="outline" class="cursor-pointer" onClick={() => props.onClose()}>
              {ctx.t("publish.cancel")}
            </Button>
            <Button
              type="submit"
              size="small"
              variant="danger"
              class="cursor-pointer"
              disabled={!matches() || !!props.view.busy()}
            >
              {ctx.t("publish.delete.go")}
            </Button>
          </div>
        </form>
      </DialogBody>
    </Dialog>
  )
}
