# CLAUDE.md

Read @AGENTS.md first. It holds the project rules, and the package `AGENTS.md` files hold the rules for each package.

## Quick reference

- Runtime: Bun 1.4.4 for tooling and tests; the built server runs on Node, so no `Bun.*` in `core`, `server`, `schema` or `protocol`.
- Checks: `bun run check` from the root; `bun typecheck` and `bun test` from a package directory, never the root.
- Lint touched files with `bunx oxlint <paths>`; GUI plugins also run `bunx ast-grep scan -c ../../script/ast-grep/gui-plugins/sgconfig.yml src` from `packages/gui-plugins`.
- Stay on the current branch, commit only when asked, and never restart the developer's running servers.
- The Cloudflare account is shared with a live project: only touch resources our database created.
