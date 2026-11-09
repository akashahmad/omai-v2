#!/usr/bin/env bun
// bun run user:create --username <u> --email <e> --password <p> [--admin]
// Reads the database settings from .env.local (use `bun run --env-file=../../.env.prod script/user-create.ts` for Northflank).
import { parseArgs } from "node:util"
import { Database } from "../src/db/database.js"
import { Users } from "../src/users.js"

const args = parseArgs({
  options: {
    username: { type: "string" },
    email: { type: "string" },
    password: { type: "string" },
    admin: { type: "boolean" },
  },
}).values
if (!args.username || !args.email || !args.password) {
  console.error("Usage: bun run user:create --username <name> --email <email> --password <password> [--admin]")
  process.exit(1)
}
const db = await Database.open({
  databaseUrl: process.env.OMAI_DATABASE_URL || undefined,
  dataDir: process.env.OMAI_CONTROLPLANE_DATA_DIR || ".omai-controlplane",
})
const user = await Users.create(db, {
  username: args.username,
  email: args.email,
  password: args.password,
  admin: args.admin === true,
})
console.log(user.id)
process.exit(0)
