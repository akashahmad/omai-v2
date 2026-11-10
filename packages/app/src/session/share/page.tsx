import { createResource, createSignal, Match, Show, Switch } from "solid-js"
import { useParams } from "@solidjs/router"
import { Title } from "@solidjs/meta"
import type { SessionInfo, SessionMessageInfo } from "@opencode/client/promise"
import { DataProvider } from "@opencode/session-ui/context"
import { SessionTimeline } from "@opencode/session-ui/timeline"
import { useControlPlane } from "@/controlplane/session"
import { useLanguage } from "@/runtime/i18n/language"
import { BrandIcon } from "@/shell/brand-icon"
import { BrandLoader } from "@/shell/brand-loader"
import { MessageRail } from "./message-rail"

/**
 * The public page behind a share link: the conversation as its owner last shared it, read-only, with no sign-in.
 */
export function SharePage() {
  const params = useParams()
  const session = useControlPlane()
  const language = useLanguage()
  const [scroller, setScroller] = createSignal<HTMLElement>()

  const [shared] = createResource(
    () => params.id,
    async (id) => {
      const found = await session.client.shares.read(id)

      if (!found) return undefined

      // SAFETY: the copy is what the owner's app read from its project server, `SessionInfo` and its messages.
      return {
        ...found,
        session: found.data.session as SessionInfo,
        messages: found.data.messages as SessionMessageInfo[],
      }
    },
  )

  const date = (at: number) =>
    new Intl.DateTimeFormat(language.intl(), { dateStyle: "medium", timeStyle: "short" }).format(at)

  return (
    <div class="flex h-dvh w-full flex-col overflow-hidden bg-v2-background-bg-base text-v2-text-text-base">
      <header class="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-v2-border-border-base px-4 md:px-6">
        <a href="/" class="flex cursor-pointer items-center gap-2.5">
          <BrandIcon class="size-7 rounded-[7px]" />
          <span class="text-[14px] font-[600] tracking-[0.3em]">
            O M A I <span class="text-[#1a64d6]">+</span>
          </span>
        </a>
        <span class="rounded-full bg-[#1a64d6]/15 px-2.5 py-1 text-[12px] font-[500] text-[#0a3a78] dark:text-[#7fb0ff]">
          {language.t("share.page.badge")}
        </span>
      </header>
      <Switch>
        <Match when={shared.loading}>
          <div class="flex flex-1 flex-col items-center justify-center gap-3">
            <BrandLoader />
            <span class="text-[13px] text-v2-text-text-muted">{language.t("share.page.loading")}</span>
          </div>
        </Match>
        <Match when={shared()}>
          {(value) => (
            <main
              ref={setScroller}
              class="min-h-0 flex-1 overflow-y-auto [&_[data-timeline-row=UserMessage]]:scroll-mt-[24px]"
            >
              <Show when={scroller()}>
                {(element) => <MessageRail messages={value().messages} scroller={element()} />}
              </Show>
              <Title>{`${value().title} · O M A I +`}</Title>
              <div class="mx-auto flex w-full max-w-[820px] flex-col gap-8 px-4 pt-10 pb-24 md:px-6">
                <div class="flex flex-col gap-2">
                  <h1 class="text-[24px] leading-[32px] font-[650] tracking-[-0.02em]">{value().title}</h1>
                  <span class="text-[13px] text-v2-text-text-muted">{date(value().sharedAt)}</span>
                </div>
                <DataProvider
                  data={{
                    session: [value().session],
                    session_status: { [value().session.id]: { type: "idle" } },
                    session_diff: {},
                  }}
                  directory={value().session.location.directory}
                  sessionID={value().session.id}
                >
                  <SessionTimeline
                    class="select-text"
                    document={{
                      sessionID: value().session.id,
                      messages: value().messages,
                      status: { type: "idle" },
                      diffs: [],
                    }}
                  />
                </DataProvider>
              </div>
            </main>
          )}
        </Match>
        <Match when={true}>
          <div class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <BrandIcon class="size-14 rounded-[12px] opacity-60" />
            <h1 class="text-[18px] font-[600]">{language.t("share.page.missing.title")}</h1>
            <p class="max-w-[360px] text-[13px] text-v2-text-text-muted">
              {language.t("share.page.missing.description")}
            </p>
          </div>
        </Match>
      </Switch>
    </div>
  )
}
