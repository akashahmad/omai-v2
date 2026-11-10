import { createMemo, createResource, createSignal, Match, Show, Switch } from "solid-js"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { useDialog } from "@opencode/ui/context/dialog"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Tooltip } from "@opencode/ui/tooltip"
import { useControlPlaneOptional } from "@/controlplane/session"
import { projectOfConnection } from "@/controlplane/presence"
import { useLanguage } from "@/runtime/i18n/language"
import { useServer } from "@/runtime/server/current"
import { useServerSDK } from "@/runtime/server/client"
import { usePlatform } from "@/runtime/platform/platform"
import { fetchSessionExport } from "@/session/commands/export"

/** The public address of a shared conversation. */
export const shareUrl = (id: string) => `${window.location.origin}/share/${encodeURIComponent(id)}`

/**
 * The chat header's Share button, in multi-user mode on a project's own session: shares the conversation by a public
 * link anyone can open, as the old app did.
 */
export function SessionShareButton(props: { sessionID: string }) {
  const session = useControlPlaneOptional()
  const server = useServer()
  const dialog = useDialog()
  const language = useLanguage()

  const project = createMemo(() =>
    server.conn.type === "http" ? projectOfConnection(server.conn.http.url) : undefined,
  )

  return (
    <Show when={session && project()}>
      {(projectID) => (
        <Tooltip placement="bottom" value={language.t("session.share.title")}>
          <IconButton
            type="button"
            variant="ghost-muted"
            size="large"
            class="shrink-0"
            icon={<Icon name="share" />}
            aria-label={language.t("session.share.title")}
            onClick={() => void dialog.show(() => <ShareDialog projectID={projectID()} sessionID={props.sessionID} />)}
          />
        </Tooltip>
      )}
    </Show>
  )
}

function ShareDialog(props: { projectID: string; sessionID: string }) {
  const session = useControlPlaneOptional()!
  const sdk = useServerSDK()
  const platform = usePlatform()
  const language = useLanguage()
  const [busy, setBusy] = createSignal<"share" | "stop">()
  const [error, setError] = createSignal<string>()
  const [copied, setCopied] = createSignal(false)

  const [share, { mutate }] = createResource(async () => {
    const found = await session.client.shares.get(props.projectID, props.sessionID)

    return found === "none" ? undefined : found
  })

  const link = () => {
    const current = share()

    return current ? shareUrl(current.id) : undefined
  }

  // The link shows the conversation as it is now: every message, with its images inline.
  const publish = async () => {
    setBusy("share")
    setError(undefined)
    await fetchSessionExport({ sessionID: props.sessionID, api: sdk.api })
      .then((data) =>
        session.client.shares.put(props.projectID, props.sessionID, {
          title: data.info.title || language.t("session.share.untitled"),
          data: { session: data.info, messages: data.messages },
        }),
      )
      .then((shared) => mutate(shared))
      .catch(() => setError(language.t("session.share.failed")))
      .finally(() => setBusy(undefined))
  }

  const stop = async () => {
    setBusy("stop")
    setError(undefined)
    await session.client.shares
      .remove(props.projectID, props.sessionID)
      .then(() => mutate(undefined))
      .catch(() => setError(language.t("session.share.failed")))
      .finally(() => setBusy(undefined))
  }

  const copy = async () => {
    const url = link()

    if (!url) return
    await (platform.writeClipboardText?.(url) ?? navigator.clipboard.writeText(url))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const sharedAt = () => {
    const current = share()

    return current
      ? new Intl.DateTimeFormat(language.intl(), { dateStyle: "medium", timeStyle: "short" }).format(current.sharedAt)
      : ""
  }

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitleGroup
          title={language.t("session.share.title")}
          description={language.t("session.share.description")}
        />
      </DialogHeader>
      <DialogBody>
        <div class="flex w-[min(460px,calc(100vw-48px))] flex-col gap-4 px-5 pb-5">
          <Switch>
            <Match when={share.loading}>
              <div class="py-4 text-[13px] text-v2-text-text-muted">{language.t("common.loading")}…</div>
            </Match>
            <Match when={link()}>
              {(url) => (
                <>
                  <div class="flex items-center gap-2 rounded-[8px] border border-v2-border-border-base bg-v2-background-bg-layer-01 py-1.5 ps-3 pe-1.5">
                    <Icon name="link" class="shrink-0 text-v2-text-text-muted" />
                    <input
                      readOnly
                      value={url()}
                      class="min-w-0 flex-1 bg-transparent text-[13px] text-v2-text-text-base outline-none"
                      onFocus={(event) => event.currentTarget.select()}
                    />
                    <button
                      type="button"
                      class="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-[6px] bg-[#0a3a78] px-2.5 text-[12px] font-[600] text-[#fff] hover:bg-[#082f62]"
                      onClick={() => void copy()}
                    >
                      <Icon name={copied() ? "check" : "copy"} size="small" />
                      {copied() ? language.t("common.copied") : language.t("session.share.copy")}
                    </button>
                  </div>
                  <p class="text-[12px] text-v2-text-text-muted">
                    {language.t("session.share.sharedAt", { at: sharedAt() })}
                  </p>
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <button
                      type="button"
                      class="h-8 cursor-pointer rounded-[6px] px-3 text-[13px] font-[500] text-[#dc2626] hover:bg-[#dc2626]/10 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={busy() !== undefined}
                      onClick={() => void stop()}
                    >
                      {busy() === "stop" ? language.t("session.share.stopping") : language.t("session.share.stop")}
                    </button>
                    <div class="flex gap-2">
                      <a
                        href={url()}
                        target="_blank"
                        rel="noopener"
                        class="flex h-8 cursor-pointer items-center rounded-[6px] border border-v2-border-border-base px-3 text-[13px] font-[500] text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover"
                      >
                        {language.t("session.share.open")}
                      </a>
                      <button
                        type="button"
                        class="h-8 cursor-pointer rounded-[6px] border border-v2-border-border-base px-3 text-[13px] font-[500] text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={busy() !== undefined}
                        onClick={() => void publish()}
                      >
                        {busy() === "share" ? language.t("session.share.updating") : language.t("session.share.update")}
                      </button>
                    </div>
                  </div>
                </>
              )}
            </Match>
            <Match when={true}>
              <p class="text-[13px] text-v2-text-text-base">{language.t("session.share.explain")}</p>
              <div class="flex justify-end">
                <button
                  type="button"
                  class="flex h-9 cursor-pointer items-center gap-2 rounded-[6px] bg-[#0a3a78] px-4 text-[13px] font-[600] text-[#fff] hover:bg-[#082f62] disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={busy() !== undefined || !!share.error}
                  onClick={() => void publish()}
                >
                  <Icon name="link" size="small" />
                  {busy() === "share" ? language.t("session.share.creating") : language.t("session.share.create")}
                </button>
              </div>
            </Match>
          </Switch>
          <Show when={error() ?? (share.error ? language.t("session.share.failed") : undefined)}>
            {(message) => <p class="text-[12px] text-[#dc2626]">{message()}</p>}
          </Show>
        </div>
      </DialogBody>
    </Dialog>
  )
}
