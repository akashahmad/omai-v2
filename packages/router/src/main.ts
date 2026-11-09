import { Router } from "./router.js"

const required = ["OMAI_TOKEN_PUBLIC_KEY", "OMAI_APP_ORIGIN", "OMAI_CONTROL_PLANE_URL"] as const
const missing = required.filter((name) => !process.env[name])
if (missing.length > 0) {
  console.error(`Missing router configuration: ${missing.join(", ")}`)
  process.exit(1)
}

const router = await Router.start({
  port: Number(process.env.OMAI_ROUTER_PORT || 4200),
  publicKey: process.env.OMAI_TOKEN_PUBLIC_KEY!,
  appOrigin: process.env.OMAI_APP_ORIGIN!,
  controlPlaneUrl: process.env.OMAI_CONTROL_PLANE_URL!.replace(/\/+$/, ""),
})
console.log(`router listening on ${router.port}`)
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void router.close().then(() => process.exit(0))
  })
