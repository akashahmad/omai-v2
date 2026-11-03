FROM debian:bookworm-slim AS base

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*

FROM base AS build-amd64
COPY dist/cli-linux-x64/bin/omai /usr/local/bin/omai

FROM base AS build-arm64
COPY dist/cli-linux-arm64/bin/omai /usr/local/bin/omai

ARG TARGETARCH
FROM build-${TARGETARCH}
RUN omai --version
ENTRYPOINT ["omai"]
