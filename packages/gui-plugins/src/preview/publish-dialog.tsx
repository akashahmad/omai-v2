import { usePlugin } from "@opencode/plugin/gui"
import { Button } from "@opencode/ui/button"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"

/** Publish, as the old panel showed it. Deploying isn't built yet, so the action says so instead of running. */
export function PublishDialog() {
  const ctx = usePlugin()

  return (
    <Dialog class="w-[440px]">
      <DialogHeader>
        <DialogTitleGroup title={ctx.t("publish.title")} />
      </DialogHeader>
      <DialogBody>
        <div class="flex flex-col gap-4 pb-1">
          <p class="text-[13px] text-v2-text-text-muted text-center leading-[1.5]">
            {ctx.t("publish.description")}
          </p>
          <Button variant="contrast" size="large" disabled class="w-full">
            <span class="flex items-center justify-center gap-2">
              <Icon name="cloud-upload" size="small" />
              {ctx.t("publish.action")}
            </span>
          </Button>
          <p class="text-12-regular text-v2-text-text-faint text-center">{ctx.t("publish.soon")}</p>
        </div>
      </DialogBody>
    </Dialog>
  )
}
