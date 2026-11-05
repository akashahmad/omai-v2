import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261105154259_publish",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`publish_deploy\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`status\` text NOT NULL,
          \`stage\` text,
          \`kind\` text,
          \`error\` text,
          \`stages\` text NOT NULL,
          \`log\` text DEFAULT '' NOT NULL,
          \`session_id\` text,
          \`time_started\` integer NOT NULL,
          \`time_finished\` integer
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`publish_domain\` (
          \`hostname\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`is_primary\` integer NOT NULL,
          \`cf_id\` text,
          \`status\` text NOT NULL,
          \`ssl\` text NOT NULL,
          \`verification\` text,
          \`error\` text,
          \`time_checked\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`publish_site\` (
          \`project_id\` text PRIMARY KEY,
          \`name\` text NOT NULL UNIQUE,
          \`kind\` text,
          \`time_published\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`publish_deploy_project_idx\` ON \`publish_deploy\` (\`project_id\`,\`time_started\`);`,
      )
      yield* tx.run(`CREATE INDEX \`publish_domain_project_idx\` ON \`publish_domain\` (\`project_id\`);`)
    })
  },
}

export default migration
