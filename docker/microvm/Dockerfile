# The image every project VM runs: `omai serve` plus the tools apps are built with. It holds no secrets and is public.
# Built and smoke-tested by `bun script/vm-image.ts` in packages/controlplane, or the "Images" GitHub workflow.

# The builder runs on the build machine's own platform and cross-builds the linux-x64 binary, so an arm64 laptop
# builds at full speed. It is not part of the image.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.4 AS builder
# The build runs the Node it embeds in the binary, which needs libatomic.
RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN bun install --os=* --cpu=* --ignore-scripts && bun run --cwd packages/core fix-node-pty
RUN cd packages/cli && OMAI_CHANNEL=prod OMAI_TARGET=linux-x64 bun run build --single --skip-install --outdir=dist-vm \
  && cp -r dist-vm/cli-linux-x64 /omai

FROM debian:bookworm-slim

# Rarely changing layers first: system packages, Node 22 and the package managers.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg git ripgrep unzip chromium fonts-liberation libatomic1 \
  && mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
  && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends nodejs \
  && npm install -g pnpm@10 bun@1.3.14 \
  && npm cache clean --force \
  && apt-get purge -y gnupg && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache /tmp/*

# The website audit and the projects page's screenshots drive this browser.
ENV CHROME_PATH=/usr/bin/chromium

# The server and everything it starts run as `omai`, with no sudo. Its home is the project volume.
RUN useradd --create-home --home-dir /home/omai --shell /bin/bash --uid 1000 omai

COPY --from=builder /omai/ /opt/omai/
RUN ln -s /opt/omai/bin/omai /usr/local/bin/omai && omai --version
COPY docker/microvm/entrypoint.sh /usr/local/bin/omai-entrypoint

EXPOSE 4096 4097
ENTRYPOINT ["/usr/local/bin/omai-entrypoint"]
