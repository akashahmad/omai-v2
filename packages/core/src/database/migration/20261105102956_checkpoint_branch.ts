import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261105102956_checkpoint_branch",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`checkpoint_branch\` (
          \`session_id\` text PRIMARY KEY,
          \`root_session_id\` text NOT NULL,
          \`parent_session_id\` text NOT NULL,
          \`boundary_key\` text NOT NULL,
          \`revert_message_id\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_checkpoint_branch_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_checkpoint_branch_root_session_id_session_v2_id_fk\` FOREIGN KEY (\`root_session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`checkpoint_branch_root_idx\` ON \`checkpoint_branch\` (\`root_session_id\`);`)
    })
  },
}

export default migration
