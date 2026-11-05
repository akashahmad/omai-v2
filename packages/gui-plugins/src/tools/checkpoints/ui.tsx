// The Checkpoints panel's own pieces; the ones every tool shares come from the Tools folder.

import { usePlugin } from "@opencode/plugin/gui"
import type { FileDiff } from "@opencode/schema/file-diff"

const STATUS = {
  added: { class: "bg-[#3f8f6a]/12 text-[#3f8f6a]", letter: "A" },
  modified: { class: "bg-[#c99a3c]/15 text-[#a77a22]", letter: "M" },
  deleted: { class: "bg-[#c4483e]/12 text-[#c4483e]", letter: "D" },
} satisfies Record<FileDiff.Info["status"], { class: string; letter: string }>

/** The one-letter chip of a file's change, spelled out for hover and assistive technology. */
export function StatusChip(props: { status: FileDiff.Info["status"] }) {
  const ctx = usePlugin()

  return (
    <span
      title={ctx.t(`checkpoints.status.${props.status}`)}
      aria-label={ctx.t(`checkpoints.status.${props.status}`)}
      class={`shrink-0 inline-flex items-center justify-center size-[18px] rounded-md text-[10px] font-[600] font-mono ${STATUS[props.status].class}`}
    >
      {STATUS[props.status].letter}
    </span>
  )
}
