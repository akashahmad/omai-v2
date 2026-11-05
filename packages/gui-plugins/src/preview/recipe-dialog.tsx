import type { JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { usePlugin } from "@opencode/plugin/gui"
import type { Preview } from "@opencode/schema/preview"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { TextInput } from "@opencode/ui/text-input"

/** Edits how the preview installs and starts the project. Saving stores it as the user's recipe and restarts. */
export function RecipeDialog(props: { recipe?: Preview.Recipe; onSave: (recipe: Preview.Recipe | null) => void }) {
  const ctx = usePlugin()
  const dialog = useDialog()

  const [form, setForm] = createStore({
    root: props.recipe?.root ?? ".",
    install: props.recipe?.install ?? "",
    command: props.recipe?.command ?? "",
    port: props.recipe?.port === undefined ? "" : String(props.recipe.port),
  })

  const port = () => (form.port.trim() === "" ? undefined : Number(form.port))
  const valid = () => form.command.trim() !== "" && (port() === undefined || Number.isInteger(port()))

  const save = () => {
    if (!valid()) return
    props.onSave({
      root: form.root.trim() || ".",
      kind: "command",
      install: form.install.trim() || undefined,
      command: form.command.trim(),
      port: port(),
      source: "user",
    })
    dialog.close()
  }

  return (
    <Dialog class="w-[480px]">
      <DialogHeader>
        <DialogTitleGroup title={ctx.t("dialog.title")} description={ctx.t("dialog.description")} />
      </DialogHeader>
      <DialogBody>
        <form
          class="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            save()
          }}
        >
          <Field label={ctx.t("dialog.root")}>
            <TextInput value={form.root} onInput={(event) => setForm("root", event.currentTarget.value)} />
          </Field>
          <Field label={ctx.t("dialog.install")}>
            <TextInput
              value={form.install}
              placeholder={ctx.t("dialog.install.placeholder")}
              onInput={(event) => setForm("install", event.currentTarget.value)}
            />
          </Field>
          <Field label={ctx.t("dialog.command")}>
            <TextInput value={form.command} onInput={(event) => setForm("command", event.currentTarget.value)} />
          </Field>
          <Field label={ctx.t("dialog.port")}>
            <TextInput
              value={form.port}
              numeric
              placeholder={ctx.t("dialog.port.placeholder")}
              invalid={port() !== undefined && !Number.isInteger(port())}
              onInput={(event) => setForm("port", event.currentTarget.value)}
            />
          </Field>
          <div class="flex items-center justify-between gap-2 pt-1">
            <Button
              type="button"
              size="small"
              variant="ghost"
              onClick={() => {
                props.onSave(null)
                dialog.close()
              }}
            >
              {ctx.t("dialog.reset")}
            </Button>
            <div class="flex gap-2">
              <Button type="button" size="small" variant="outline" onClick={() => dialog.close()}>
                {ctx.t("dialog.cancel")}
              </Button>
              <Button type="submit" size="small" variant="contrast" disabled={!valid()}>
                {ctx.t("dialog.save")}
              </Button>
            </div>
          </div>
        </form>
      </DialogBody>
    </Dialog>
  )
}

function Field(props: { label: string; children: JSX.Element }) {
  return (
    <label class="flex flex-col gap-1 text-12-medium text-v2-text-text-muted">
      {props.label}
      {props.children}
    </label>
  )
}
