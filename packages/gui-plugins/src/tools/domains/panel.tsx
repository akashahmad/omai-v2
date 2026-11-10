// The Domains tool: connects the user's own domains to the published site. It shows the platform subdomain and what it
// does, one card per domain with its status and the DNS records it still needs, and the field that adds a domain.

import { createSignal, For, Match, Show, Switch, type JSX } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { Menu } from "@opencode/ui/menu"
import { Tooltip } from "@opencode/ui/tooltip"
import type { Publish } from "@opencode/schema/publish"
import { Busy, card, Failure, iconButton, kicker, Note, primary, quiet, secondary, Spinner } from "../ui"
import { LIMIT, pill, type Pill } from "./model"
import type { DomainsView } from "./view"

export function DomainsPanel(props: { view: DomainsView; onPublish: () => void }) {
  const ctx = usePlugin()

  return (
    <div data-component="tools-domains" class="@container flex flex-col gap-4 pb-10">
      <div class="flex items-start gap-3">
        <div class="flex flex-1 min-w-0 flex-col gap-1">
          <span class="text-16-medium text-v2-text-text-base">{ctx.t("domains.title")}</span>
          <div class="text-[13px] text-v2-text-text-muted">{ctx.t("domains.description")}</div>
        </div>
        <Tooltip value={ctx.t("domains.refresh")} placement="left">
          <button
            type="button"
            data-action="domains-refresh"
            aria-label={ctx.t("domains.refresh")}
            class={`${iconButton} size-8`}
            onClick={() => void props.view.refresh()}
          >
            <Icon name="refresh" size="small" />
          </button>
        </Tooltip>
      </div>
      {/* A session switch brings another view without remounting the panel; its body starts afresh with it. */}
      <Show when={props.view} keyed>
        {(view) => <Body view={view} onPublish={props.onPublish} />}
      </Show>
    </div>
  )
}

function Body(props: { view: DomainsView; onPublish: () => void }) {
  const ctx = usePlugin()
  const view = props.view

  // Pending domains are checked again while this body is on screen.
  view.watch()

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
          <Empty icon="globe" title={ctx.t("publish.notConfigured.title")} body={ctx.t("publish.notConfigured.body")} />
        </Match>
        <Match when={!view.site()}>
          <Empty
            icon="cloud-upload"
            title={ctx.t("domains.needsPublish.title")}
            body={ctx.t("domains.needsPublish.body")}
          >
            <button type="button" data-action="domains-go-publish" class={primary} onClick={() => props.onPublish()}>
              <Icon name="cloud-upload" size="small" />
              {ctx.t("domains.needsPublish.go")}
            </button>
          </Empty>
        </Match>
        <Match when={view.site()}>
          <Show when={view.subdomain()}>{(subdomain) => <Subdomain view={view} subdomain={subdomain()} />}</Show>
          <For each={view.domains()}>{(domain) => <DomainCard view={view} domain={domain} />}</For>
          <Add view={view} />
          <DnsHelp />
        </Match>
      </Switch>
    </Show>
  )
}

// Where each common registrar explains adding DNS records. The video link searches YouTube, so it never goes stale.
const PROVIDERS = [
  { name: "Cloudflare", guide: "https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/" },
  { name: "GoDaddy", guide: "https://www.godaddy.com/help/add-a-cname-record-19236" },
  {
    name: "Namecheap",
    guide:
      "https://www.namecheap.com/support/knowledgebase/article.aspx/9646/2237/how-to-create-a-cname-record-for-your-domain/",
  },
  { name: "Hostinger", guide: "https://www.hostinger.com/support/1583249-how-to-manage-dns-records-at-hostinger/" },
  { name: "Bluehost", guide: "https://www.bluehost.com/help/article/dns-management-add-edit-or-delete-dns-entries" },
  {
    name: "Squarespace",
    guide: "https://support.squarespace.com/hc/en-us/articles/360002101888-Edit-your-domain-s-DNS-records",
  },
  {
    name: "IONOS",
    guide:
      "https://www.ionos.com/help/domains/configuring-cname-records-for-subdomains/configuring-a-cname-record-for-a-subdomain/",
  },
  { name: "Porkbun", guide: "https://kb.porkbun.com/article/68-how-to-edit-dns-records" },
  { name: "Hover", guide: "https://support.hover.com/support/solutions/articles/201000064728" },
  {
    name: "AWS Route 53",
    guide: "https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resource-record-sets-creating.html",
  },
] as const

const BASICS = [
  { label: "domains.help.basics.dns", url: "https://www.cloudflare.com/learning/dns/what-is-dns/" },
  { label: "domains.help.basics.cname", url: "https://www.cloudflare.com/learning/dns/dns-records/dns-cname-record/" },
  { label: "domains.help.basics.txt", url: "https://www.cloudflare.com/learning/dns/dns-records/dns-txt-record/" },
] as const

const video = (provider: string) =>
  `https://www.youtube.com/results?search_query=${encodeURIComponent(`${provider} add CNAME record`)}`

/** For people new to DNS: where their registrar explains adding the records above, and what the records are. */
function DnsHelp() {
  const ctx = usePlugin()

  const link =
    "inline-flex items-center gap-1 cursor-pointer rounded-[6px] px-1.5 py-0.5 text-12-medium text-[color-mix(in_srgb,#1a64d6_80%,var(--v2-text-text-base))] hover:bg-[#1a64d6]/15 "

  return (
    <section data-slot="domains-help" class={`${card} flex flex-col gap-4`}>
      <div class="flex flex-col gap-1">
        <span class="text-14-medium text-v2-text-text-base">{ctx.t("domains.help.title")}</span>
        <span class="text-12-regular leading-[1.5] text-v2-text-text-muted">{ctx.t("domains.help.body")}</span>
      </div>
      <ul class="grid grid-cols-1 gap-2 @[480px]:grid-cols-2 @[760px]:grid-cols-3">
        <For each={PROVIDERS}>
          {(provider) => (
            <li class="flex items-center justify-between gap-2 rounded-[10px] border border-v2-border-border-base px-3 py-2.5">
              <span class="min-w-0 truncate text-13-medium text-v2-text-text-base">{provider.name}</span>
              <span class="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  class={link}
                  aria-label={ctx.t("domains.help.guideFor", { provider: provider.name })}
                  onClick={() => ctx.system.openExternal(provider.guide)}
                >
                  <Icon name="square-arrow-top-right" size="small" />
                  {ctx.t("domains.help.guide")}
                </button>
                <button
                  type="button"
                  class={link}
                  aria-label={ctx.t("domains.help.videoFor", { provider: provider.name })}
                  onClick={() => ctx.system.openExternal(video(provider.name))}
                >
                  <Icon name="outline-video" size="small" />
                  {ctx.t("domains.help.video")}
                </button>
              </span>
            </li>
          )}
        </For>
      </ul>
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-v2-border-border-base pt-3">
        <span class="text-12-regular text-v2-text-text-muted">{ctx.t("domains.help.basics")}</span>
        <For each={BASICS}>
          {(item) => (
            <button type="button" class={link} onClick={() => ctx.system.openExternal(item.url)}>
              {ctx.t(item.label)}
              <Icon name="square-arrow-top-right" size="small" />
            </button>
          )}
        </For>
      </div>
    </section>
  )
}

function Empty(props: { icon: "globe" | "cloud-upload"; title: string; body: string; children?: JSX.Element }) {
  return (
    <div
      data-slot="domains-empty"
      class="flex flex-col items-center gap-3 px-6 py-10 rounded-xl border border-dashed border-v2-border-border-base text-center"
    >
      <span class="flex items-center justify-center size-12 rounded-xl bg-v2-overlay-simple-overlay-hover text-v2-text-text-muted">
        <Icon name={props.icon} />
      </span>
      <div class="flex flex-col gap-1 max-w-[340px]">
        <b class="text-14-medium text-v2-text-text-base">{props.title}</b>
        <span class="text-12-regular leading-[1.5] text-v2-text-text-muted">{props.body}</span>
      </div>
      {props.children}
    </div>
  )
}

/** The platform subdomain: it serves the site until a primary domain is active, then sends visitors there. */
function Subdomain(props: { view: DomainsView; subdomain: { host: string; redirects: boolean } }) {
  const ctx = usePlugin()

  return (
    <div data-slot="domains-subdomain" class={card}>
      <span class={kicker}>{ctx.t("domains.subdomain")}</span>
      <div class="flex items-center gap-3 min-w-0">
        <span class="shrink-0 flex items-center justify-center size-8 rounded-lg bg-[#0a3a78] text-[#fff]">
          <Icon name="globe" size="small" />
        </span>
        <div class="flex flex-1 min-w-0 flex-col gap-0.5">
          <button
            type="button"
            title={`https://${props.subdomain.host}`}
            class="self-start max-w-full truncate text-start font-mono text-[13px] text-v2-text-text-base cursor-pointer hover:underline"
            onClick={() => ctx.system.openExternal(`https://${props.subdomain.host}`)}
          >
            {props.subdomain.host}
          </button>
          <span class="text-12-regular text-v2-text-text-muted">
            <Show when={props.subdomain.redirects} fallback={ctx.t("domains.subdomainServes")}>
              {ctx.t("domains.subdomainRedirects", { host: props.view.primary()?.hostname ?? "" })}
            </Show>
          </span>
        </div>
      </div>
    </div>
  )
}

/** One domain: its host, whether it is the primary, its status and its menu; until active, the DNS records it needs. */
function DomainCard(props: { view: DomainsView; domain: Publish.Domain }) {
  const ctx = usePlugin()
  const [open, setOpen] = createSignal(true)
  const state = () => pill(props.domain)
  const waiting = () => props.domain.status !== "active"
  const busy = () => props.view.busyWith(props.domain.hostname)

  const remove = () =>
    ctx.dialogs.open((dialog) => (
      <RemoveDialog view={props.view} hostname={props.domain.hostname} onClose={dialog.close} />
    ))

  return (
    <div data-slot="domains-card" class={`${card} gap-3`}>
      <div class="flex items-center gap-2 min-w-0">
        <div class="flex flex-1 min-w-0 flex-col gap-1">
          <button
            type="button"
            title={`https://${props.domain.hostname}`}
            class="self-start max-w-full truncate text-start text-14-medium text-v2-text-text-base cursor-pointer hover:underline"
            onClick={() => ctx.system.openExternal(`https://${props.domain.hostname}`)}
          >
            {props.domain.hostname}
          </button>
          <div class="flex flex-wrap items-center gap-1.5">
            <StatusPill state={state()} />
            <Show
              when={props.domain.primary}
              fallback={<span class="text-12-regular text-v2-text-text-muted">{ctx.t("domains.redirects")}</span>}
            >
              <span class="inline-flex items-center h-5 px-1.5 rounded-md bg-[#1a64d6]/15 text-[11px] font-medium text-[color-mix(in_srgb,#1a64d6_85%,var(--v2-text-text-base))]">
                {ctx.t("domains.primary")}
              </span>
            </Show>
          </div>
        </div>
        <Show when={busy()}>
          <Spinner />
        </Show>
        <Menu gutter={4} placement="bottom-end" modal={false}>
          <Menu.Trigger
            as="button"
            type="button"
            data-action="domains-menu"
            aria-label={ctx.t("domains.menu")}
            class={`${iconButton} size-7`}
            disabled={!!props.view.busy()}
          >
            <Icon name="outline-dots" size="small" />
          </Menu.Trigger>
          <Menu.Portal>
            {/* The menu's own stylesheet sets `cursor: default` on its items, so the pointer is important. */}
            <Menu.Content class="w-48">
              <Show when={!props.domain.primary}>
                <Menu.Item
                  data-action="domains-make-primary"
                  class="cursor-pointer!"
                  onSelect={() => void props.view.setPrimary(props.domain.hostname)}
                >
                  <Icon name="check" size="small" />
                  <span>{ctx.t("domains.makePrimary")}</span>
                </Menu.Item>
              </Show>
              <Menu.Item
                data-action="domains-check-one"
                class="cursor-pointer!"
                onSelect={() => void props.view.check(props.domain.hostname)}
              >
                <Icon name="refresh" size="small" />
                <span>{ctx.t("domains.checkNow")}</span>
              </Menu.Item>
              <Menu.Separator />
              <Menu.Item data-action="domains-remove" data-variant="critical" class="cursor-pointer!" onSelect={remove}>
                <Icon name="trash" size="small" />
                <span>{ctx.t("domains.remove")}</span>
              </Menu.Item>
            </Menu.Content>
          </Menu.Portal>
        </Menu>
      </div>

      <Show when={props.domain.error}>
        {(error) => <span class="text-12-regular text-[#c4483e] break-words">{error()}</span>}
      </Show>

      <Show when={waiting()}>
        <div class="flex flex-col gap-2">
          <button
            type="button"
            aria-expanded={open()}
            class={`${quiet} self-start -ms-1.5`}
            onClick={() => setOpen(!open())}
          >
            <Icon
              name="fill-triangle-down"
              size="small"
              class="transition-transform"
              classList={{ "-rotate-90": !open() }}
            />
            {ctx.t("domains.records.title")}
          </button>
          <Show when={open()}>
            <div class="flex flex-col gap-2">
              <For each={props.domain.records}>{(record) => <RecordRow record={record} />}</For>
              <Show when={props.domain.apex}>
                <Note tone="info" icon="info">
                  {ctx.t("domains.apex.hint")}
                </Note>
              </Show>
              {/* A root domain already lists the TXT record as required; the tip is for domains where it's optional. */}
              <Show when={!props.domain.records.some((record) => record.type === "TXT") && props.domain.verification}>
                {(record) => <Moving record={record()} />}
              </Show>
              <div>
                <button
                  type="button"
                  data-action="domains-check"
                  class={`${secondary} h-7 px-2.5`}
                  disabled={!!props.view.busy()}
                  onClick={() => void props.view.check(props.domain.hostname)}
                >
                  <Icon name="refresh" size="small" />
                  {ctx.t("domains.checkNow")}
                </button>
              </div>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}

function StatusPill(props: { state: Pill }) {
  const ctx = usePlugin()

  return (
    <span
      data-slot="domains-status"
      class="inline-flex items-center gap-1.5 h-5 px-1.5 rounded-md text-[11px] font-medium"
      classList={{
        "bg-[#3f8f6a]/12 text-[#3f8f6a]": props.state === "active",
        "bg-[#c48a1e]/12 text-[#a8741a]": props.state === "dns",
        "bg-[#1a64d6]/15 text-[#1a64d6]": props.state === "certificate",
        "bg-[#c4483e]/12 text-[#c4483e]": props.state === "error",
      }}
    >
      <span class="size-1.5 rounded-full bg-current" />
      {ctx.t(`domains.status.${props.state}`)}
    </span>
  )
}

/** A DNS record to set at the domain's provider, with copy buttons, and whether DNS already shows it. */
function RecordRow(props: { record: Publish.DnsRecord }) {
  const ctx = usePlugin()

  return (
    <div
      data-slot="domains-record"
      class="flex flex-col gap-1.5 p-3 rounded-lg border border-v2-border-border-base bg-v2-background-bg-base"
    >
      <div class="flex items-center gap-2">
        <span class={kicker}>{ctx.t("domains.records.type")}</span>
        <span class="font-mono text-[12px] font-medium text-v2-text-text-base">{props.record.type}</span>
        <span class="flex-1" />
        <Switch>
          <Match when={props.record.ok === true}>
            <Icon name="check" size="small" class="text-[#3f8f6a]" aria-label={ctx.t("domains.records.ok")} />
          </Match>
          <Match when={props.record.ok === false}>
            <Icon
              name="close-small"
              size="small"
              class="text-[#c4483e]"
              aria-label={ctx.t("domains.records.missing")}
            />
          </Match>
        </Switch>
      </div>
      <Field label={ctx.t("domains.records.name")} value={props.record.name} />
      <Field label={ctx.t("domains.records.value")} value={props.record.value} />
    </div>
  )
}

function Field(props: { label: string; value: string }) {
  const ctx = usePlugin()

  const copy = () =>
    ctx.system.copy(props.value).then(
      () => ctx.toast.show({ variant: "success", title: ctx.t("domains.copied"), description: props.value }),
      () => ctx.toast.show({ variant: "error", title: ctx.t("domains.copy.failed") }),
    )

  return (
    <div class="flex items-center gap-2 min-w-0">
      <span class="shrink-0 w-12 text-[11px] text-v2-text-text-faint">{props.label}</span>
      <code class="flex-1 min-w-0 truncate font-mono text-[12px] text-v2-text-text-base" title={props.value}>
        {props.value}
      </code>
      <Tooltip value={ctx.t("domains.copy")} placement="left">
        <button
          type="button"
          data-action="domains-copy"
          aria-label={ctx.t("domains.copy")}
          class={iconButton}
          onClick={() => void copy()}
        >
          <Icon name="outline-copy" size="small" />
        </button>
      </Tooltip>
    </div>
  )
}

/** Collapsed by default: the TXT record that verifies the domain before its DNS moves away from another host. */
function Moving(props: { record: Publish.DnsRecord }) {
  const ctx = usePlugin()
  const [open, setOpen] = createSignal(false)

  return (
    <div class="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open()}
        class={`${quiet} self-start -ms-1.5`}
        onClick={() => setOpen(!open())}
      >
        <Icon
          name="fill-triangle-down"
          size="small"
          class="transition-transform"
          classList={{ "-rotate-90": !open() }}
        />
        {ctx.t("domains.moving.title")}
      </button>
      <Show when={open()}>
        <span class="text-12-regular leading-[1.5] text-v2-text-text-muted">{ctx.t("domains.moving.body")}</span>
        <RecordRow record={props.record} />
      </Show>
    </div>
  )
}

/** The field that adds a domain, with the www offer when the typed host is an apex. */
function Add(props: { view: DomainsView }) {
  const ctx = usePlugin()
  const [input, setInput] = createSignal("")
  const offer = () => props.view.suggestion(input())
  const ready = () => !props.view.busy() && !props.view.full() && input().trim().length > 0

  const add = async () => {
    if (!ready()) return

    if (await props.view.add(input().trim())) setInput("")
  }

  const addBoth = async (pair: { apex: string; www: string }) => {
    if (props.view.busy() || props.view.full()) return

    if (await props.view.addWithWww(pair)) setInput("")
  }

  return (
    <div data-slot="domains-add" class={card}>
      <span class={kicker}>{ctx.t("domains.add")}</span>
      <div class="flex items-center gap-2">
        <input
          data-slot="domains-input"
          value={input()}
          spellcheck={false}
          autocomplete="off"
          disabled={props.view.full()}
          aria-label={ctx.t("domains.add")}
          placeholder={ctx.t("domains.add.placeholder")}
          class="flex-1 min-w-0 h-9 px-3 rounded-lg border border-v2-border-border-base bg-v2-background-bg-base font-mono text-[13px] text-v2-text-text-base outline-none focus:border-v2-border-border-strong placeholder:text-v2-text-text-faint disabled:opacity-60"
          onInput={(event) => setInput(event.currentTarget.value)}
          onKeyDown={(event) => event.key === "Enter" && void add()}
        />
        <button
          type="button"
          data-action="domains-add"
          class={`${primary} h-9`}
          disabled={!ready()}
          onClick={() => void add()}
        >
          <Busy when={props.view.busy() === "add"}>
            <Icon name="plus" size="small" />
          </Busy>
          {ctx.t("domains.add")}
        </button>
      </div>
      <Show when={!props.view.full() ? offer() : undefined}>
        {(pair) => (
          <Note tone="info" icon="info">
            <span class="flex flex-col items-start gap-1.5">
              <span>{ctx.t("domains.suggest.www", { apex: pair().apex, www: pair().www })}</span>
              <button
                type="button"
                data-action="domains-add-www"
                class={`${quiet} -ms-1.5 text-[#1a64d6]`}
                disabled={!!props.view.busy()}
                onClick={() => void addBoth(pair())}
              >
                <Icon name="plus-small" size="small" />
                {ctx.t("domains.suggest.add", { www: pair().www })}
              </button>
            </span>
          </Note>
        )}
      </Show>
      <Show when={props.view.full()}>
        <span class="text-12-regular text-v2-text-text-muted">{ctx.t("domains.limit", { limit: LIMIT })}</span>
      </Show>
    </div>
  )
}

function RemoveDialog(props: { view: DomainsView; hostname: string; onClose: () => void }) {
  const ctx = usePlugin()

  const submit = async () => {
    if (props.view.busy()) return

    if (await props.view.remove(props.hostname)) props.onClose()
  }

  return (
    <Dialog class="w-[440px]">
      <DialogHeader>
        <DialogTitleGroup title={ctx.t("domains.remove")} />
      </DialogHeader>
      <DialogBody>
        <div class="flex flex-col gap-3 pb-1">
          <p class="text-[13px] leading-[1.5] text-v2-text-text-muted">
            {ctx.t("domains.remove.confirm", { host: props.hostname })}
          </p>
          <Show when={props.view.error()}>{(error) => <Failure problem={error()} />}</Show>
          <div class="flex justify-end gap-2 pt-1">
            <Button type="button" size="small" variant="outline" class="cursor-pointer" onClick={() => props.onClose()}>
              {ctx.t("publish.cancel")}
            </Button>
            <Button
              type="button"
              size="small"
              variant="danger"
              class="cursor-pointer"
              disabled={!!props.view.busy()}
              onClick={() => void submit()}
            >
              {ctx.t("domains.remove")}
            </Button>
          </div>
        </div>
      </DialogBody>
    </Dialog>
  )
}
