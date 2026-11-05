import { Database as Sqlite } from "bun:sqlite"
import { createHash } from "node:crypto"
import path from "node:path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const serve = (database: string) =>
  ServerFetch.make({
    app: { version: "test" },
    database: { path: database },
    config: { project: false, content: "{}" },
    models: { fetch: false },
    fs: { filewatcher: false },
  })

const route = "http://opencode.local/api/experimental/preview/thumbnail"

it.live("lists preview thumbnails and serves each as WebP with an ETag", () =>
  Effect.gen(function* () {
    // Acquired first so it is removed after the server below is released; Windows can't delete an open db.
    const dir = (yield* tmpdirScoped("omai-thumbnail-")).path
    yield* Effect.gen(function* () {
      const database = path.join(dir, "omai.db")
      const handler = yield* serve(database)

      yield* Effect.promise(async () => {
        expect(await (await handler(new Request(route))).json()).toEqual({ data: [] })
        const image = Buffer.from("RIFF....WEBPVP8 fake")
        const hash = createHash("sha256").update(image).digest("hex")
        const sqlite = new Sqlite(database)
        sqlite
          .query("INSERT INTO preview_thumbnail (project_id, hash, data, time_created, time_updated) VALUES (?, ?, ?, ?, ?)")
          .run("prj_site", hash, image, 1, 2)
        sqlite.close()

        expect(await (await handler(new Request(route))).json()).toEqual({
          data: [{ projectID: "prj_site", hash, time: 2 }],
        })
        const served = await handler(new Request(`${route}/prj_site`))
        expect(served.status).toBe(200)
        expect(served.headers.get("content-type")).toBe("image/webp")
        expect(served.headers.get("etag")).toBe(`"${hash}"`)
        expect(served.headers.get("x-content-type-options")).toBe("nosniff")
        expect(Buffer.from(await served.arrayBuffer())).toEqual(image)

        const cached = await handler(new Request(`${route}/prj_site`, { headers: { "If-None-Match": `"${hash}"` } }))
        expect(cached.status).toBe(304)
        expect((await handler(new Request(`${route}/prj_other`))).status).toBe(404)
      })
    })
  }),
)
