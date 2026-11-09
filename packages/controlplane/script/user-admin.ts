#!/usr/bin/env bun
// bun run user:admin --username <u> --grant | --revoke
// Admins set up the platform's providers and models in Settings. Reads the database settings from .env.local.
import { parseArgs } from "node:util"
import { Database } from "../src/db/database.js"
import { Users } from "../src/users.js"

const args = parseArgs({
  options: { username: { type: "string" }, grant: { type: "boolean" }, revoke: { type: "boolean" } },
}).values
if (!args.username || args.grant === args.revoke) {
  console.error("Usage: bun run user:admin --username <name> --grant | --revoke")
  process.exit(1)
}
const db = await Database.open({
  databaseUrl: process.env.OMAI_DATABASE_URL || undefined,
  dataDir: process.env.OMAI_CONTROLPLANE_DATA_DIR || ".omai-controlplane",
})
if (!(await Users.setAdmin(db, args.username, args.grant === true))) {
  console.error(`No user named ${args.username}`)
  process.exit(1)
}
console.log(`${args.username} is ${args.grant ? "now" : "no longer"} an admin`)
process.exit(0)
