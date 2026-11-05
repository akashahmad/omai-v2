<p align="center">
  <img src="packages/app/public/web-app-manifest-192x192.png" alt="O M A I + logo" width="96" height="96">
</p>
<h1 align="center">O M A I +</h1>
<p align="center">Build, preview and publish apps with AI.</p>

---

## What it does

- **AI sessions** that write and change your project's code.
- **Live preview** of the running app, with visual editing and a website audit.
- **Git and Checkpoints** to commit, push and pull, and to restore code and conversation to any earlier point.
- **Publishing and Domains** to put an app online on Cloudflare and connect custom domains.

## Requirements

- [Bun](https://bun.sh) 1.4.4
- Node.js with npm (to install, run and publish the apps you build)
- Git
- Google Chrome (for preview thumbnails)

## Getting started

```bash
bun install
cp .env.sample .env    # then fill in the values
bun dev serve --port 4096 --cors localhost:3000 # server
cd packages/app && bun dev -- --port 4444   # web app
```

Open http://localhost:3000. It talks to the server on port 4096.

## Environment

The server reads these variables. `bun dev` loads them from `.env` in the repository root.

| Variable                             | Required       | Description                                                                   |
| ------------------------------------ | -------------- | ----------------------------------------------------------------------------- |
| `OMAI_CLOUDFLARE_API_TOKEN`          | For publishing | Cloudflare API token (permissions below)                                      |
| `OMAI_CLOUDFLARE_ACCOUNT_ID`         | For publishing | Cloudflare account ID                                                         |
| `OMAI_CLOUDFLARE_PLATFORM_ZONE`      | No             | Zone that published apps are served on, as `<name>.<zone>`. Default `omai.ch` |
| `OMAI_CLOUDFLARE_DISPATCH_NAMESPACE` | No             | Workers for Platforms dispatch namespace. Default `omai-apps`                 |
| `OMAI_CLOUDFLARE_APEX_IPS`           | No             | Comma-separated IPs, only if the account has Cloudflare apex proxying         |

Without the Cloudflare variables, everything else works and the Publishing and Domains tools show "not set up".

### Cloudflare API token permissions

Create a custom token at **My Profile → API Tokens** with the permissions below.

| Scope   | Permission           | Access | Used for                                                       |
| ------- | -------------------- | ------ | -------------------------------------------------------------- |
| Account | Workers Scripts      | Edit   | Uploading apps to the dispatch namespace                       |
| Account | Workers KV Storage   | Edit   | The hostname → app map that the dispatcher reads               |
| Zone    | Workers Routes       | Edit   | Routing the platform zone and custom domains to the dispatcher |
| Zone    | DNS                  | Edit   | Wildcard and fallback-origin records                           |
| Zone    | SSL and Certificates | Edit   | Custom hostnames (Cloudflare for SaaS)                         |
| Zone    | Zone                 | Read   | Looking up the zone                                            |

Limit the token to your account and the platform zone. The account also needs **Workers for Platforms**, and the zone needs **Cloudflare for SaaS** enabled.

## Development

```bash
bun run check          # lint and type-check everything, from the repository root
cd packages/core && bun test   # tests run from a package directory, never the root
```

See [AGENTS.md](./AGENTS.md) for the code style and patterns
