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
cp .env.sample .env.local    # then fill in the values
bun dev serve --port 4096 --cors localhost:3000 # server (loads .env.local)
cd packages/app && bun dev -- --port 4444   # web app
```

Open http://localhost:3000. It talks to the server on port 4096.

## Environment

The server reads these variables from one of two files in the repository root, both git-ignored:

- `.env.local`: local development without MicroVMs. `bun dev` loads it.
- `.env.prod`: the multi-user setup on Northflank MicroVMs (project `omaiv2`, never `omai`). `bun dev:prod` loads it, so you can run the server against production-like settings from your machine.

`.env.sample` lists every variable for both.

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

## Multi-user deployment (in progress)

> Partly built: accounts, projects, the router, local VMs, pausing idle VMs, shared and personal model keys, and publishing work (`packages/controlplane`, `packages/router`). The Northflank provider and the VM image work from a laptop (below); deploying the control plane, router and app to Northflank is still to come. Design: [docs/superpowers/specs/2026-11-06-multi-user-microvm-design.md](./docs/superpowers/specs/2026-11-06-multi-user-microvm-design.md). The single-user setup above is unchanged.

### Running it locally

```bash
bun run dev:multi                                   # control plane (4100, internal 4101) and router (4200), from .env.local
cd packages/controlplane && bun run user:create --username ada --email ada@example.com --password '<password>'
cd packages/app && VITE_OMAI_API_URL=http://localhost:4100 bun dev -- --port 4444
```

Open http://localhost:4444 and sign in. Each project runs its own `omai serve` process with its folder under `OMAI_LOCAL_PROJECTS_ROOT`. With `OMAI_DATABASE_URL` empty the control plane uses an embedded PGlite database under `OMAI_CONTROLPLANE_DATA_DIR`; set it to use Postgres (for example a local Docker container). `bun run dev:multi:prod` loads `.env.prod`, for real Northflank VMs (see **Northflank VMs from a laptop** below).

**Models.** Two kinds of providers reach a VM, connected with an API key or a sign-in (ChatGPT, GitHub Copilot and the like):

- **Shared providers:** an admin (`bun run user:create … --admin`, or `bun run user:admin --username <name> --grant` / `--revoke` in `packages/controlplane`) connects providers, with an API key or a sign-in, in **Settings > Shared providers** and switches models on in **Settings > Shared models** (off by default). Those pages work on the **platform server**, a private O M A I + server the control plane runs under `OMAI_CONTROLPLANE_DATA_DIR/platform`; the router lets only its settings routes through, for admins only.
- **Personal providers:** every user connects their own providers in **Settings > Providers** on any of their projects. They are stored on the control plane under that user, encrypted with `OMAI_SECRETS_KEY` (32 bytes, base64; generated into the data directory when unset), and reach all of that user's projects within a minute, and nobody else's. A sign-in made on one project moves to the control plane, which refreshes it; every project, including that one, then holds only a stand-in for it. Their **Settings > Models** switches are saved on the control plane too, so every project and browser of theirs shows the same models. These pages need an open project; Extensions belong to each project.

A user's own credential for a provider wins over the shared one; removing it brings the shared one back. **Secrets stay on the control plane:** a VM holds a stand-in (`omai-gw.…`) for every shared provider and every personal sign-in, and any request carrying one goes through the control plane's model gateway (`/internal/projects/<id>/gateway/…`), which puts the real key or token in and forwards the call, streamed, only to that provider's own hosts. Personal API keys still reach their owner's VMs and go straight to the provider. Credentials kept outside the credential store (AWS Bedrock profiles, Google Vertex's default login, the Azure CLI, the Claude agent CLI) can't be shared or synced. Each VM fetches its list at start and every minute and keeps a copy. VMs report token usage per AI step to the `model_usage` table. Every user shares the admin's accounts and their limits, so a subscription's rate limits apply to all of them together.

A project's VM pauses after `OMAI_VM_IDLE_MS` (2 minutes) without activity, unless it is busy. Activity is someone using the open project's tab (the app reports it every 30 s, and at once after a quiet spell; working inside the preview counts) and actions through the router: changes such as sending a message, and terminal input. Reads, the event stream and heartbeats don't count, since an open app keeps sending them on its own. Busy means a session step, an install, build or publish, a program running in a terminal (an idle shell doesn't count), or a preview viewed in the last 2 minutes; each VM reports it every 10 s. Opening a project, its card showing or being hovered on the projects pages, someone using its tab, or an action through the router starts a paused VM again; a read to a paused VM gets `503` at once. Locally, pausing stops the project's `omai serve` process, and resuming starts it on the same port.

With `OMAI_VM_RESERVES_PER_USER` above 0, each active user keeps that many **reserve VMs** booted ahead (at most `OMAI_VM_RESERVES_MAX` in all). Creating a project claims one: it is already running, so the app opens it and uploads an attached zip straight away, and a new reserve boots behind it. A user is active while they have a sign-in seen in the last `OMAI_VM_RESERVE_IDLE_MS` (the app pings while they click, type or move the pointer) or a project VM running. Once neither holds, their reserves are deleted, service and volume. A reserve is a hidden `project` row with `reserved_at` set. Deleting one first marks it, on condition it is still unclaimed, and a claim only takes unmarked rows, so a claimed project can never be deleted. The provider only deletes the names it derives from the reserve's own ID. A control plane with reserves off never touches them, so a local one can't delete the deployed one's.

The deployment has four parts: the web app (`app.omai.ch`), the control plane (`api.omai.ch`), the router (its default Northflank address) and one Northflank MicroVM per project. **Only the control plane holds secrets.** The router and VMs get a public key and their own project token, nothing else.

### Control plane

| Variable                          | Required          | Description                                                                                                                                                                                                                                  |
| --------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OMAI_DATABASE_URL`               | Yes               | Postgres connection string (the Northflank addon's private address in production)                                                                                                                                                            |
| `OMAI_APP_ORIGIN`                 | Yes               | The web app's origin, e.g. `https://app.omai.ch`. Only this origin may make authenticated requests                                                                                                                                           |
| `OMAI_TOKEN_SIGNING_KEY`          | Yes               | Ed25519 private key (PEM) that signs VM access tokens. Never leaves the control plane                                                                                                                                                        |
| `OMAI_TOKEN_PUBLIC_KEY`           | Yes               | The matching public key (PEM), handed to the router and every VM                                                                                                                                                                             |
| `OMAI_ROUTER_URL`                 | Yes               | The router's public address (its default Northflank `*.code.run` URL)                                                                                                                                                                        |
| `OMAI_VM_PROVIDER`                | No                | `local` (one `omai serve` process per project on this machine) or `northflank`. Default `local`                                                                                                                                              |
| `OMAI_LOCAL_PROJECTS_ROOT`        | With `local`      | Folder that stands in for VM volumes when running locally                                                                                                                                                                                    |
| `OMAI_CONTROLPLANE_DATA_DIR`      | No                | Local data (PGlite database, local VMs). Default `.omai-controlplane`                                                                                                                                                                        |
| `OMAI_CONTROLPLANE_PORT`          | No                | Public API port. Default `4100`                                                                                                                                                                                                              |
| `OMAI_CONTROLPLANE_INTERNAL_PORT` | No                | Internal API port (router and VMs only). Default `4101`                                                                                                                                                                                      |
| `OMAI_CONTROLPLANE_INTERNAL_HOST` | No                | Address the internal API listens on. Default `127.0.0.1`; the private network address in production                                                                                                                                          |
| `OMAI_LOCAL_SERVE_COMMAND`        | No                | With `local`: the command that starts a project's server, as a JSON array. Default runs `packages/cli` with Bun                                                                                                                              |
| `OMAI_TEST_DATABASE_URL`          | No                | Also runs the control plane's database tests against this Postgres                                                                                                                                                                           |
| `OMAI_SIGNUP_ENABLED`             | No                | `true` shows the signup page and allows signups. Default `false`                                                                                                                                                                             |
| `OMAI_SECRETS_KEY`                | In production     | Encrypts users' own provider keys at rest (32 bytes, base64). Generated into `OMAI_CONTROLPLANE_DATA_DIR` when unset, for local use                                                                                                          |
| `OMAI_VM_IDLE_MS`                 | No                | Genuine inactivity before a VM is paused. Default `120000` (2 minutes)                                                                                                                                                                       |
| `OMAI_VM_SWEEP_MS`                | No                | How often idle VMs are looked for. Default `15000`                                                                                                                                                                                           |
| `OMAI_VM_BUSY_FRESH_MS`           | No                | How long a VM's pushed busy report is trusted before the VM is asked directly. Default `30000`                                                                                                                                               |
| `OMAI_VM_UNREACHABLE_GRACE_MS`    | No                | An idle VM that can't be asked whether it is busy is paused after this long. Default `60000`                                                                                                                                                 |
| `OMAI_VM_RECONCILE_MS`            | No                | How often running VMs are compared with the database (VMs the database doesn't know are only logged). Default `180000`                                                                                                                       |
| `OMAI_VM_RESERVES_PER_USER`       | No                | Reserve VMs kept booted for each active user; creating a project claims one, so it opens at once. Default `0` (off). Set it only on the deployed control plane                                                                               |
| `OMAI_VM_RESERVE_IDLE_MS`         | No                | A user's reserves are deleted after this long with no activity and no project VM running. Default `600000` (10 minutes)                                                                                                                      |
| `OMAI_VM_RESERVES_MAX`            | No                | The most reserves across all users. Default `20`                                                                                                                                                                                             |
| `OMAI_SESSION_IDLE_MS`            | No                | Browser inactivity before the user is logged out. Default `900000` (15 minutes)                                                                                                                                                              |
| `OMAI_VM_WAKE_TIMEOUT_MS`         | No                | How long to wait for a VM to create or resume. Default `90000`                                                                                                                                                                               |
| `OMAI_ZIP_MAX_BYTES`              | No                | Largest zip accepted when creating a project                                                                                                                                                                                                 |
| `OMAI_PUBLISH_MAX_BYTES`          | No                | Largest publish upload a project's VM may send (its packed site). Default `314572800` (300 MB)                                                                                                                                               |
| `OMAI_PUBLISH_CONCURRENCY`        | No                | Uploads to Cloudflare running at once across all projects; more wait their turn. Default `4`                                                                                                                                                 |
| `OMAI_NORTHFLANK_API_TOKEN`       | With `northflank` | Northflank API token (permissions below)                                                                                                                                                                                                     |
| `OMAI_NORTHFLANK_PROJECT`         | With `northflank` | Northflank project that holds the VMs, router and control plane                                                                                                                                                                              |
| `OMAI_NORTHFLANK_IMAGE`           | With `northflank` | VM image path, e.g. `docker.io/jj123dev/omai-microvm:v1`                                                                                                                                                                                     |
| `OMAI_NORTHFLANK_PLAN`            | No                | Compute plan per VM. Default `nf-compute-100-4` (1 vCPU, 4 GB)                                                                                                                                                                               |
| `OMAI_NORTHFLANK_VOLUME_SIZE_GB`  | No                | Volume size per project, at least 6 (Northflank's smallest). Default `10`                                                                                                                                                                    |
| `OMAI_NORTHFLANK_NAME_PREFIX`     | No                | Names the VMs `<prefix>-vm-<projectID>` and volumes `<prefix>-vol-…`; nothing without it is ever paused or resumed. 1–12 characters. Default `omai`                                                                                          |
| `OMAI_NORTHFLANK_PUBLIC_VMS`      | No                | `true` also makes each VM's API port public, so a router on a laptop can reach it. Refused unless `OMAI_APP_ORIGIN` is a localhost origin                                                                                                    |
| `OMAI_NORTHFLANK_API_BASE`        | No                | Northflank API address. Default `https://api.northflank.com/v1`                                                                                                                                                                              |
| `OMAI_PREVIEW_PORT`               | No                | The port a VM's preview listens on, published by Northflank. Default `4097`                                                                                                                                                                  |
| `OMAI_PLATFORM_URL`               | In production     | Where the router reaches the platform server: the control plane's private address on its own port, e.g. `http://omai-controlplane:4102`. It then listens on all interfaces at that port. Default: loopback, for a router on the same machine |
| `OMAI_CONTROL_PLANE_VM_URL`       | No                | How VMs reach the internal API. Default `http://127.0.0.1:<internal port>` (local VMs); the control plane's private address on Northflank                                                                                                    |
| `OMAI_CLOUDFLARE_*`               | For publishing    | The Cloudflare variables above. In multi-user mode they live **only** on the control plane: a VM builds and packs the site, the control plane uploads it                                                                                     |

Create users with `bun run user:create --username <name> --email <email> --password <password>` in `packages/controlplane`. Generate a token key pair for an env file with `bun script/gen-token-keys.ts` in `packages/controlplane`.

### Router

| Variable                 | Required | Description                                                      |
| ------------------------ | -------- | ---------------------------------------------------------------- |
| `OMAI_TOKEN_PUBLIC_KEY`  | Yes      | Verifies VM access tokens                                        |
| `OMAI_CONTROL_PLANE_URL` | Yes      | The control plane's private address, for waking VMs and activity |
| `OMAI_APP_ORIGIN`        | Yes      | Same as on the control plane                                     |
| `OMAI_ROUTER_PORT`       | No       | Port to listen on. Default `4200`                                |

### MicroVM

The control plane sets these when it creates a project's VM. Never set them by hand, and never add a secret here: the agent can run commands on the VM, so anything in its environment is readable by that project's user.

| Variable                 | Description                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| `OMAI_PROJECT_ID`        | The project this VM serves. The VM rejects tokens for any other project                                  |
| `OMAI_PROJECT_SLUG`      | Folder name under `/home/omai`                                                                           |
| `OMAI_PROJECT_TOKEN`     | Authorises this project's own calls to the control plane (summary, busy reports, model keys, publishing) |
| `OMAI_CONTROL_PLANE_URL` | The control plane's private address                                                                      |
| `OMAI_TOKEN_PUBLIC_KEY`  | Verifies VM access tokens                                                                                |
| `OMAI_APP_ORIGIN`        | The web app's origin, the only one the VM's server accepts requests from                                 |
| `OMAI_PREVIEW_PORT`      | The preview's port, public on Northflank; the VM asks the control plane for its public address           |
| `OMAI_PREVIEW_PUBLIC`    | `1`: the preview's public address works for anyone while the VM runs, with no ticket from the app        |
| `OMAI_PROJECTS_HOME`     | The volume, `/home/omai`; the project lives in `<home>/<slug>`                                           |

### Web app

| Variable                    | Required | Description                                                                                              |
| --------------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `VITE_OMAI_API_URL`         | Yes      | Control plane address, e.g. `https://api.omai.ch`. Setting it switches the app to multi-user mode        |
| `VITE_OMAI_SESSION_IDLE_MS` | No       | Browser inactivity before logout. Default `900000` (15 minutes); keep it equal to `OMAI_SESSION_IDLE_MS` |

### Northflank API token permissions

Northflank tokens take their permissions from an API role: create an API role in your team's settings, then generate the token from it. Restrict the role to the one Northflank project that holds the VMs (**Project restrictions**), so the token can't touch anything else in the team.

| Area                        | Permission           | Used for                                                           |
| --------------------------- | -------------------- | ------------------------------------------------------------------ |
| Project                     | Read                 | Resolving the project name to its ID                               |
| Services → General          | Create               | Creating a project's VM                                            |
| Services → General          | Read                 | Status, containers and the private and public addresses of each VM |
| Services → General          | Update               | Pausing and resuming VMs, and changing image or plan               |
| Services → Networking/Ports | Read                 | Looking up the VM's public preview address                         |
| Volumes                     | Create, Read, Update | Creating each project's volume and attaching it to its VM          |

**Leave out every Delete permission.** O M A I + never hard-deletes a project, VM or volume, so the token shouldn't be able to. End-to-end checks name their VMs `omai-e2e-*` (`OMAI_NORTHFLANK_NAME_PREFIX=omai-e2e`) and leave them paused; delete them by hand in the Northflank dashboard. Leave out secrets, team and billing permissions too.

Pause needs **Services → General → Update** (per Northflank's API reference). The other names follow Northflank's role editor; check them there when creating the role, since Northflank can rename them.

### Images

Four images, all `linux/amd64`, built from the repository root with the Dockerfiles in `docker/`:

| Image                                  | Dockerfile                       | Runs                                                                                                                                                                                                                     |
| -------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docker.io/jj123dev/omai-controlplane` | `docker/controlplane/Dockerfile` | The control plane bundled for Node (`bun run build` in `packages/controlplane`), with npm for wrangler and the `omai` binary for the platform server. Data in `/data`; create users with `node dist/node/user-create.js` |
| `docker.io/jj123dev/omai-router`       | `docker/router/Dockerfile`       | The router, bundled and run under Node                                                                                                                                                                                   |
| `docker.io/jj123dev/omai-web`          | `docker/web/Dockerfile`          | The web app's static build behind nginx on 8080. `VITE_OMAI_API_URL` is a build argument                                                                                                                                 |
| `docker.io/jj123dev/omai-microvm`      | `docker/microvm/Dockerfile`      | One project VM (below)                                                                                                                                                                                                   |

None of them holds a secret: `.dockerignore` keeps env files, git and local data out of the build, and secrets come from the environment at run time. Build and push them with the **Images** GitHub workflow (Actions > Images > Run workflow), which runs only when started by hand. It takes a tag (default `v1`), a checkbox for each image to build (tick any number), and the web app's control plane address (the `api_url` input, default `https://api.omai.ch`; when emptied, the `VITE_OMAI_API_URL` repository variable or secret), and needs the repository secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`.

**The VM image** is Debian with Node 22, npm, pnpm, Bun, git, ripgrep and Chromium, and the `omai` binary. The server runs as the user `omai` (no sudo), and the project volume is its home, `/home/omai`, so the project, its sessions and installed tools survive a pause. The workflow builds it with the script below, which smoke-tests it before pushing: it runs the image with a volume and only the VM's variables, and checks that the server answers, runs as `omai` without sudo, sees no other variables, has no env files or keys, and keeps files across a restart. To build and test it locally:

```bash
cd packages/controlplane
bun script/vm-image.ts --image docker.io/jj123dev/omai-microvm --tag <tag>          # build and smoke-test
bun script/vm-image.ts --image docker.io/jj123dev/omai-microvm --tag <tag> --push   # and push it
```

Set `OMAI_NORTHFLANK_IMAGE` to the pushed image.

### Northflank VMs from a laptop

To try real VMs before anything is deployed, run the control plane and router locally with `OMAI_VM_PROVIDER=northflank`, `OMAI_NORTHFLANK_PROJECT=omaiv2`, `OMAI_NORTHFLANK_PUBLIC_VMS=true` and an `OMAI_APP_ORIGIN` on `localhost`. Each VM's API port is then public, so the local router reaches it; the VM still accepts only tokens the control plane signed. The VMs can't reach a control plane on a laptop, so model keys, busy reports and publishing don't work this way unless `OMAI_CONTROL_PLANE_VM_URL` points at a tunnel to the internal port. Use `OMAI_NORTHFLANK_NAME_PREFIX=omai-e2e` for test VMs and delete them by hand afterwards.

### DNS

Only two records under `omai.ch`: `app` (web app) and `api` (control plane), pointing at their Northflank services. The router and previews use their Northflank `*.code.run` addresses and need no DNS. `omai.ch` is on the Cloudflare account shared with a live project, so add these two records by hand and change nothing else.

## Development

```bash
bun run check          # lint and type-check everything, from the repository root
cd packages/core && bun test   # tests run from a package directory, never the root
```

See [AGENTS.md](./AGENTS.md) for the code style and patterns
