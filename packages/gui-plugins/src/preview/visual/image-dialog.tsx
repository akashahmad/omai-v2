import { createSignal, onCleanup, Show } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { Loader } from "@opencode/ui/loader"
import type { PreviewView } from "../view"
import { shell } from "./fields"
import { Link } from "./glyphs"
import type { ElementInfo } from "./protocol"

// The controller accepts these types up to 8 MB (core preview/controller.ts `asset`); checking here answers at once.
const MAX_BYTES = 8 * 1024 * 1024

const CHECKER = "repeating-conic-gradient(rgb(0 0 0 / 0.06) 0 25%, transparent 0 50%) 0 0 / 14px 14px"

/** Replaces an image in the preview: a file the user drops or chooses (saved into the app), or an address. */
export function ImageDialog(props: { view: PreviewView; element: ElementInfo; close: () => void }) {
  const ctx = usePlugin()
  const [url, setUrl] = createSignal("")
  const [alt, setAlt] = createSignal(props.element.alt ?? "")
  const [preview, setPreview] = createSignal<string>()
  const [file, setFile] = createSignal<File>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [over, setOver] = createSignal(false)
  const current = () => props.element.srcUrl ?? props.element.src
  let picker: HTMLInputElement | undefined

  // The chosen file's preview is an object URL; release it when it's replaced or the dialog closes.
  const showFile = (value: string | undefined) => {
    const previous = preview()

    if (previous) URL.revokeObjectURL(previous)
    setPreview(value)
  }

  onCleanup(() => showFile(undefined))

  const choose = (chosen: File | undefined) => {
    if (!chosen || !chosen.type.startsWith("image/")) return
    setError(undefined)

    if (chosen.size > MAX_BYTES) return setError(ctx.t("visual.imageDialog.tooLarge"))
    setFile(chosen)
    setUrl("")
    showFile(URL.createObjectURL(chosen))
  }

  const apply = async () => {
    setError(undefined)
    const chosen = file()
    const visual = props.view.visual

    if (chosen) {
      setBusy(true)
      const base64 = await read(chosen)

      const saved = await props.view.asset(chosen.name, base64).then(
        (value) => ({ value }),
        (failure: { readonly message?: string } | undefined) => ({ failure: failure?.message ?? "" }),
      )

      setBusy(false)

      if ("failure" in saved) return setError(ctx.t("visual.imageDialog.failed", { reason: saved.failure }))
      visual.attribute("src", saved.value.url)
    }

    if (!chosen && url().trim()) visual.attribute("src", url().trim())

    if (alt() !== (props.element.alt ?? "")) visual.attribute("alt", alt())
    props.close()
  }

  const next = () => preview() ?? (url().trim() || undefined)

  return (
    <Dialog class="w-[480px]" fit>
      <DialogHeader>
        <DialogTitleGroup title={ctx.t("visual.imageDialog.title")} />
      </DialogHeader>
      <DialogBody>
        <div class="flex flex-col gap-4 min-h-0 max-h-[calc(100vh-140px)] overflow-y-auto px-5 pb-5">
          <Show when={current()}>
            {(src) => (
              <div class="flex items-center gap-3 p-2 rounded-xl bg-v2-overlay-simple-overlay-hover">
                <img
                  src={src()}
                  alt=""
                  class="size-11 shrink-0 rounded-lg object-cover bg-v2-background-bg-base shadow-[inset_0_0_0_1px_var(--v2-border-border-base)]"
                />
                <div class="flex flex-col min-w-0">
                  <span class="text-[11px] text-v2-text-text-muted">{ctx.t("visual.imageDialog.current")}</span>
                  <span class="text-[12.5px] text-v2-text-text-base truncate">{fileName(props.element.src ?? src())}</span>
                </div>
              </div>
            )}
          </Show>

          <button
            type="button"
            class="group relative flex flex-col items-center justify-center gap-2 h-44 px-6 rounded-xl border border-dashed text-center cursor-pointer transition-colors overflow-hidden"
            classList={{
              "border-[#1a64d6] bg-[#1a64d6]/[0.08]": over(),
              "border-v2-border-border-strong hover:border-[#1a64d6]/60 hover:bg-[#1a64d6]/[0.04]": !over(),
            }}
            onClick={() => picker?.click()}
            onDragOver={(event) => {
              event.preventDefault()
              setOver(true)
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(event) => {
              event.preventDefault()
              setOver(false)
              choose(event.dataTransfer?.files[0])
            }}
          >
            <Show
              when={next()}
              fallback={
                <>
                  <span
                    class="flex items-center justify-center size-11 rounded-full transition-colors"
                    classList={{
                      "bg-[#1a64d6]/15 text-[#1a64d6]": over(),
                      "bg-v2-overlay-simple-overlay-hover text-v2-text-text-muted group-hover:text-[#1a64d6]": !over(),
                    }}
                  >
                    <Icon name="cloud-upload" />
                  </span>
                  <span class="text-[13px] font-[500] text-v2-text-text-base">{ctx.t("visual.imageDialog.dropTitle")}</span>
                  <span class="text-[12px] text-v2-text-text-muted -mt-1">
                    {ctx.t("visual.imageDialog.dropBody")}
                  </span>
                  <span class="text-[11px] text-v2-text-text-faint">{ctx.t("visual.imageDialog.formats")}</span>
                </>
              }
            >
              {(src) => (
                <>
                  <span class="absolute inset-0" style={{ background: CHECKER }} />
                  <img src={src()} alt="" class="relative max-h-full max-w-full object-contain p-3" />
                  <span class="absolute inset-x-2 bottom-2 flex items-center gap-2 px-2.5 h-7 rounded-lg bg-[#000]/60 text-[11.5px] text-[#fff] backdrop-blur-sm">
                    <span class="truncate">{file()?.name ?? fileName(url())}</span>
                    <Show when={file()}>{(chosen) => <span class="shrink-0 opacity-70">{size(chosen().size)}</span>}</Show>
                    <span class="ms-auto shrink-0 opacity-0 transition-opacity group-hover:opacity-90">
                      {ctx.t("visual.imageDialog.change")}
                    </span>
                  </span>
                </>
              )}
            </Show>
          </button>
          <input ref={picker} type="file" accept="image/*" class="hidden" onChange={(event) => choose(event.currentTarget.files?.[0])} />

          <div class="flex items-center gap-3 text-[11px] text-v2-text-text-faint">
            <span class="h-px flex-1 bg-v2-border-border-base" />
            {ctx.t("visual.imageDialog.or")}
            <span class="h-px flex-1 bg-v2-border-border-base" />
          </div>

          <label class={`${shell} h-9`}>
            <span class="flex items-center justify-center w-9 shrink-0 text-v2-text-text-faint">
              <Link />
            </span>
            <input
              class="h-9 flex-1 min-w-0 bg-transparent pe-3 text-[13px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
              placeholder={ctx.t("visual.imageDialog.url")}
              value={url()}
              spellcheck={false}
              onInput={(event) => {
                setUrl(event.currentTarget.value)
                setFile(undefined)
                showFile(undefined)
              }}
            />
          </label>

          <label class="flex flex-col gap-1.5">
            <span class="text-[11px] text-v2-text-text-muted">{ctx.t("visual.alt")}</span>
            <span class={`${shell} h-9`}>
              <input
                class="h-9 flex-1 min-w-0 bg-transparent px-3 text-[13px] text-v2-text-text-base outline-none"
                value={alt()}
                onInput={(event) => setAlt(event.currentTarget.value)}
              />
            </span>
          </label>

          <Show when={error()}>
            {(text) => (
              <p class="flex items-start gap-2 p-2.5 rounded-lg bg-v2-state-bg-danger text-[12px] text-v2-state-fg-danger">
                <Icon name="circle-exclamation" size="small" class="shrink-0 mt-px" />
                {text()}
              </p>
            )}
          </Show>

          <div class="flex justify-end gap-2 pt-1">
            <button
              type="button"
              class="h-8 px-3.5 rounded-lg text-12-medium text-v2-text-text-base cursor-pointer hover:bg-v2-overlay-simple-overlay-hover"
              onClick={() => props.close()}
            >
              {ctx.t("visual.imageDialog.cancel")}
            </button>
            <button
              type="button"
              class="inline-flex items-center gap-1.5 h-8 px-4 rounded-lg bg-[#0a3a78] text-[#fff] text-12-medium cursor-pointer hover:bg-[#082f62] disabled:opacity-50 disabled:cursor-default"
              disabled={busy() || (!file() && !url().trim() && alt() === (props.element.alt ?? ""))}
              onClick={() => void apply()}
            >
              <Show when={busy()}>
                <Loader width={14} height={14} style={{ color: "inherit" }} />
              </Show>
              {busy() ? ctx.t("visual.imageDialog.uploading") : ctx.t("visual.imageDialog.apply")}
            </button>
          </div>
        </div>
      </DialogBody>
    </Dialog>
  )
}

// The last part of an address, without its query: what people recognise an image by.
const fileName = (value: string) => value.split("?")[0]!.split("/").filter(Boolean).at(-1) ?? value

const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`)

// A file as base64, without its data-URL prefix.
function read(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    // readAsDataURL always reads a string: "data:<type>;base64,<data>".
    reader.onload = () => {
      const result = String(reader.result)
      resolve(result.slice(result.indexOf(",") + 1))
    }

    reader.onerror = () => reject(new Error("The file could not be read."))
    reader.readAsDataURL(file)
  })
}
