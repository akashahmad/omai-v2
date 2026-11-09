# The control plane: accounts, projects, VMs, publishing. It runs on Node. It is the only service that holds secrets; they come from
# the environment at run time, never from the image. Context: the repository root.

# The platform server (admins' shared providers) is an `omai serve` the control plane starts itself, so this image
# carries the same linux-x64 binary as the VMs.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.4 AS cli
# The build runs the Node it embeds in the binary, which needs libatomic.
RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN bun install --os=* --cpu=* --ignore-scripts && bun run --cwd packages/core fix-node-pty
RUN cd packages/cli && OMAI_CHANNEL=prod OMAI_TARGET=linux-x64 bun run build --single --skip-install --outdir=dist-image \
  && cp -r dist-image/cli-linux-x64 /omai

# The control plane bundled for Node (see packages/controlplane/script/build-node.ts).
FROM --platform=$BUILDPLATFORM oven/bun:1.4.4 AS bundle
WORKDIR /src
COPY . .
RUN bun install --ignore-scripts --filter @opencode/controlplane && cd packages/controlplane && bun run build

# Runs on Node, not Bun. npm is needed too: publishing installs and runs wrangler with it.
FROM node:24-bookworm-slim
WORKDIR /app/packages/controlplane
COPY --from=bundle /src/packages/controlplane/dist/node ./dist/node
COPY --from=bundle /src/packages/controlplane/migration ./migration
# PGlite and pg, kept outside the bundle, at the versions its package.json pins.
RUN cd dist/node && npm install --omit=dev --no-audit --no-fund && npm cache clean --force
# The omai binary embeds Node 26, which needs libatomic.
RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 && rm -rf /var/lib/apt/lists/*
COPY --from=cli /omai/ /opt/omai/
RUN ln -s /opt/omai/bin/omai /usr/local/bin/omai && omai --version
RUN mkdir -p /data && chown node:node /data
USER node

# The internal API listens on every interface of the container; publish its port privately only.
ENV OMAI_CONTROLPLANE_DATA_DIR=/data \
  OMAI_CONTROLPLANE_INTERNAL_HOST=0.0.0.0 \
  OMAI_LOCAL_SERVE_COMMAND='["omai","serve"]'
EXPOSE 4100 4101
# Admin scripts: `node dist/node/user-create.js --username … --email … --password …`, `node dist/node/user-admin.js`.
CMD ["node", "dist/node/main.js"]
