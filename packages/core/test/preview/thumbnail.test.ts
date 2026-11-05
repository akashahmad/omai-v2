import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@opencode/core/database/database"
import { PreviewThumbnail } from "@opencode/core/preview/thumbnail"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([PreviewThumbnail.node, Database.node])))

const image = (text: string) => Buffer.from(text)

describe("PreviewThumbnail", () => {
  it.effect("keeps one image per project, replaced by the next capture", () =>
    Effect.gen(function* () {
      const thumbnails = yield* PreviewThumbnail.Service
      const { db } = yield* Database.Service

      yield* thumbnails.save("prj_a", image("first"))
      yield* thumbnails.save("prj_a", image("second"))
      yield* thumbnails.save("prj_b", image("other"))
      const a = yield* PreviewThumbnail.read(db, "prj_a")

      expect(a && Buffer.from(a.data).toString()).toBe("second")
      expect(a?.hash).toBe(PreviewThumbnail.hash(image("second")))
      expect((yield* PreviewThumbnail.list(db)).map((item) => item.projectID).toSorted()).toEqual(["prj_a", "prj_b"])
    }),
  )

  it.effect("a project without a capture has none", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service

      expect(yield* PreviewThumbnail.read(db, "prj_none")).toBeUndefined()
    }),
  )
})
