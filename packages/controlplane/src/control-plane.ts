import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { Auth } from "./auth.js"
import type { Config } from "./config.js"
import type { Db } from "./db/database.js"
import { InternalHttp } from "./http/internal.js"
import { PublicHttp } from "./http/public.js"
import { Domains } from "./domains.js"
import { Platform } from "./platform.js"
import { UserModels } from "./user-models.js"
import { Publishing } from "./publishing.js"
import { Keys } from "./keys.js"
import { Locks } from "./locks.js"
import { Projects } from "./projects.js"
import { Secrets } from "./secrets.js"
import { Shares } from "./shares.js"
import { LocalVmProvider } from "./vm/local.js"
import { NorthflankVmProvider } from "./vm/northflank.js"
import { Sweeper } from "./vm/sweeper.js"

export * as ControlPlane from "./control-plane.js"

/** Starts the public and internal listeners. Ports of 0 pick free ports, reported back. */
export async function start(config: Config, db: Db) {
  const internal = await listen(config.internalPort, config.internalHost)
  const settings = { ...config, internalPort: internal.port }
  const provider =
    settings.vmProvider === "northflank" ? NorthflankVmProvider.make(settings) : LocalVmProvider.make(settings)
  const auth = Auth.make(db, settings)
  const projects = Projects.make(db, settings, provider)
  const platform = await Platform.make({ db, config: settings })
  // Started in the background, so the control plane answers at once; the first admin to open settings waits for it.
  void platform.address().catch((error: unknown) => console.error("the platform server did not start", error))
  const keys = Keys.make({ db, config: settings, platform, secrets: await Secrets.load(settings.dataDir, process.env) })
  const locks = Locks.make()
  const publishing = Publishing.make({ db, config: settings, locks })
  const domains = Domains.make({ db, config: settings, locks })
  internal.serve(InternalHttp.make({ auth, projects, keys, publishing, domains }))
  const pub = await listen(config.port, "0.0.0.0")
  pub.serve(
    PublicHttp.make({
      config: settings,
      db,
      auth,
      projects,
      platform,
      models: UserModels.make(db),
      shares: Shares.make(db),
    }),
  )
  const stopSweeper = Sweeper.make({ db, config: settings, lifecycle: projects.lifecycle, provider }).start()
  return {
    port: pub.port,
    internalPort: internal.port,
    lifecycle: projects.lifecycle,
    async close() {
      stopSweeper()
      await Promise.all([pub.close(), internal.close(), provider.close(), platform.close()])
    },
  }
}

async function listen(port: number, host: string) {
  const handler = { current: (_req: IncomingMessage, res: ServerResponse) => void res.writeHead(503).end() }
  const server = createServer((req, res) => {
    void Promise.resolve(handler.current(req, res)).catch((error: unknown) => {
      console.error("request failed", error)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(port, host, resolve))
  const address = server.address()
  return {
    port: typeof address === "object" && address ? address.port : port,
    serve: (next: (req: IncomingMessage, res: ServerResponse) => unknown) => {
      handler.current = next as typeof handler.current
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
