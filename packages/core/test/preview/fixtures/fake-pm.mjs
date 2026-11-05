// A stand-in package manager for install tests. It counts its runs in `.runs`, fills node_modules, then exits as told.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"

const runs = existsSync(".runs") ? Number(readFileSync(".runs", "utf8")) + 1 : 1
writeFileSync(".runs", String(runs))
writeFileSync(`.args-${runs}`, process.argv.slice(2).join(" "))
mkdirSync("node_modules/x", { recursive: true })
console.log(`install run ${runs}`)

if (process.env.FAKE_PM_SLEEP) await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_PM_SLEEP)))

if (process.env.FAKE_PM_FAIL_ONCE === "1") process.exit(runs === 1 ? 1 : 0)

process.exit(Number(process.env.FAKE_PM_EXIT ?? "0"))
