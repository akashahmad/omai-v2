#!/usr/bin/env bun
// Idempotent setup for the Workers for Platforms + Cloudflare for SaaS publishing stack. Run from packages/core:
//   bunx bun@1.4.4 --env-file=../../.env script/publish-platform.ts [--dry-run]
// The account is shared with a live project, so this only creates what is missing. It never modifies or deletes an
// existing namespace, record, route or fallback origin; the one thing it replaces is the dispatcher Worker.
import { Global } from "@opencode/util/global"
import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { buildEnv } from "../src/publish/adapt"
import { Cloudflare } from "../src/publish/cloudflare"
import { DISPATCHER, KV_TITLE, PublishConfig, type Config } from "../src/publish/config"
import { PublishName } from "../src/publish/name"
import { PublishWrangler } from "../src/publish/wrangler"

/** Record types that send traffic through the zone, so they need a bypass route to stay off the dispatcher. */
const ROUTED = ["A", "AAAA", "CNAME"]
/** `domains.<zone>` is only a CNAME target; requests arrive under the customer's hostname, never under it. */
const NOT_BYPASSED = new Set(["domains"])

export type WranglerConfig = ReturnType<typeof dispatcherConfig>

export async function setup(
  config: Config,
  options: {
    dryRun: boolean
    deploy?: (wrangler: WranglerConfig) => Promise<void>
    log?: (line: string) => void
  },
) {
  const log = options.log ?? console.log
  const deploy = options.deploy ?? ((wrangler: WranglerConfig) => wranglerDeploy(config, wrangler))
  // In a dry run the client refuses every non-GET request, so a missed `mutate` fails instead of writing.
  const cf = Cloudflare.client(config, Cloudflare.TIMEOUT, { readOnly: options.dryRun })
  const conflicts: string[] = []

  /** The only path to a change. A dry run prints it and returns undefined without running it. */
  const mutate = async <T>(verb: "create" | "deploy", resource: string, run: () => Promise<T>) => {
    if (options.dryRun) {
      log(`would ${verb}  ${resource}`)
      return undefined
    }
    const result = await run()
    log(`${verb === "create" ? "created" : "deployed"}  ${resource}`)
    return result
  }

  const exists = (resource: string) => log(`exists  ${resource}`)
  const ensure = async (resource: string, present: boolean, create: () => Promise<unknown>) => {
    if (present) return exists(resource)
    await mutate("create", resource, create)
  }

  // Read once up front: the zone, the routes and the records. Routes created below are tracked by the creates.
  await cf.zoneID()
  const routes = await cf.routes()
  const records = await cf.records()

  const ensureRoute = async (pattern: string, script?: string) => {
    const resource = `route ${pattern} -> ${script ?? "(bypass)"}`
    const existing = routes.find((r) => r.pattern === pattern)
    if (!existing) return mutate("create", resource, () => cf.createRoute(pattern, script))
    if (existing.script === script) return exists(resource)
    // Never modified: it may belong to the live project. Reported so a person can resolve it.
    const message = `conflict  ${resource}: already points to ${existing.script ?? "(bypass)"}; left alone`
    conflicts.push(message)
    log(message)
  }

  // 1. Dispatch namespace
  await ensure(`dispatch namespace ${config.namespace}`, await cf.namespaceExists(), () => cf.createNamespace())

  // 2. KV namespace
  const found = await cf.findKv()
  if (found) exists(`kv namespace ${KV_TITLE}`)
  const kvID = found ?? (await mutate("create", `kv namespace ${KV_TITLE}`, () => cf.createKv()))

  // 3. Proxied wildcard record, so every `<name>.<zone>` (and `domains.<zone>`) reaches the zone.
  const wildcard = `*.${config.zone}`
  const routed = records.filter((r) => ROUTED.includes(r.type))
  await ensure(
    `dns ${wildcard}`,
    routed.some((r) => r.name === wildcard),
    () => cf.createRecord({ type: "AAAA", name: "*", content: "100::", proxied: true }),
  )

  // 4. Bypass routes keep the apex, the zone's own hosts and reserved names away from the dispatcher's routes.
  const hosts = new Set([
    config.zone,
    ...routed.map((r) => r.name).filter((name) => name !== wildcard),
    ...[...PublishName.RESERVED].filter((name) => !NOT_BYPASSED.has(name)).map((name) => `${name}.${config.zone}`),
  ])
  for (const host of hosts) await ensureRoute(`${host}/*`)

  // 5. Fallback origin for custom hostnames. An existing one is kept, whatever it points at.
  const origin = `fallback.${config.zone}`
  const current = await cf.fallbackOrigin()
  if (current) exists(`fallback origin ${current}${current === origin ? "" : ` (expected ${origin}; left alone)`}`)
  if (!current) {
    await ensure(
      `dns ${origin}`,
      routed.some((r) => r.name === origin),
      () => cf.createRecord({ type: "AAAA", name: origin, content: "100::", proxied: true }),
    )
    await mutate("create", `fallback origin ${origin}`, () => cf.setFallbackOrigin(origin))
  }

  // 6. The dispatcher is always redeployed so it runs the current source.
  const existed = await cf.workerExists(DISPATCHER)
  await mutate("deploy", `worker ${DISPATCHER} (${existed ? "replaces the live version" : "new"})`, () =>
    deploy(dispatcherConfig(config, kvID ?? "")),
  )

  // 7. Dispatcher routes, after the Worker exists so they never point at a missing script. Custom hostnames arrive
  // under the customer's hostname; Cloudflare only accepts patterns within the zone, so `*/*` catches them and the
  // more specific bypass routes above keep the zone's own hosts out of it.
  await ensureRoute(`${wildcard}/*`, DISPATCHER)
  await ensureRoute("*/*", DISPATCHER)

  log(`\nRe-run this script after adding DNS records to ${config.zone} so they get bypass routes.`)
  if (conflicts.length > 0)
    log(`${conflicts.length} conflicting route(s) were left alone; resolve them in the dashboard.`)
  return { conflicts }
}

function dispatcherConfig(config: Config, kvID: string) {
  return {
    name: DISPATCHER,
    main: path.join(import.meta.dirname, "../src/publish/dispatcher/index.ts"),
    // Matches the live dispatcher's date so the redeploy does not move its runtime semantics.
    compatibility_date: "2026-10-30",
    dispatch_namespaces: [{ binding: "DISPATCHER", namespace: config.namespace }],
    kv_namespaces: [{ binding: "HOSTNAMES", id: kvID }],
    vars: { ZONE: config.zone },
    workers_dev: false,
    preview_urls: false,
  }
}

async function wranglerDeploy(config: Config, wrangler: WranglerConfig) {
  const bin = await PublishWrangler.ensureWrangler(path.join(Global.Path.data, "publish", "tools"))
  const dir = await mkdtemp(path.join(os.tmpdir(), "omai-dispatcher-"))
  const file = path.join(dir, "wrangler.json")
  // The temporary config is removed whether the write or the deploy fails.
  const code = await writeFile(file, JSON.stringify(wrangler, null, 2) + "\n")
    .then(
      () =>
        new Promise<number | null>((resolve, reject) =>
          spawn(bin, ["deploy", "--config", file], {
            stdio: "inherit",
            // Wrangler's own variable names; the token never reaches the log.
            env: {
              ...buildEnv(),
              CLOUDFLARE_API_TOKEN: config.token,
              CLOUDFLARE_ACCOUNT_ID: config.accountID,
              WRANGLER_SEND_METRICS: "false",
            },
          })
            .on("error", reject)
            .on("close", resolve),
        ),
    )
    .finally(() => rm(dir, { recursive: true, force: true }))
  if (code !== 0) throw new Error(`wrangler deploy exited with ${code}`)
}

if (import.meta.main) {
  // Strict, so a mistyped `--dry-run` fails instead of running for real.
  const args = parseArgs({ args: process.argv.slice(2), options: { "dry-run": { type: "boolean" } }, strict: true })
  const config = PublishConfig.read()
  if (!config) {
    console.error("Set OMAI_CLOUDFLARE_ACCOUNT_ID and OMAI_CLOUDFLARE_API_TOKEN (see .env.sample).")
    process.exit(1)
  }
  const dryRun = args.values["dry-run"] === true
  console.log(`${dryRun ? "Dry run: nothing is changed. " : ""}Zone ${config.zone}, namespace ${config.namespace}\n`)
  const result = await setup(config, { dryRun }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
  // Every resource was still checked; a conflict only changes the exit status.
  if (result.conflicts.length > 0) process.exit(1)
}
