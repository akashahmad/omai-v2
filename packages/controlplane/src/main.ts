import { ControlPlaneConfig } from "./config.js"
import { ControlPlane } from "./control-plane.js"
import { Database } from "./db/database.js"

const config = ControlPlaneConfig.fromEnv(process.env)
const db = await Database.open(config)
const server = await ControlPlane.start(config, db)
console.log(`control plane listening on ${server.port} (internal ${config.internalHost}:${server.internalPort})`)
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    // Stops the project servers this control plane started, so none outlive it.
    void server.close().then(() => process.exit(0))
  })
