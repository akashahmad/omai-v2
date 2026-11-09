# The router: forwards each app request to its project's VM after checking the VM token. It holds no secrets.
# It runs under Node: Bun's node:http does not carry raw WebSocket bytes through an upgraded socket. Context: the
# repository root.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.4 AS build
WORKDIR /src
COPY . .
RUN bun install --ignore-scripts --filter @opencode/router \
  && bun build packages/router/src/main.ts --target=node --outfile=/out/main.js

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=build /out/main.js /app/main.js
USER node
EXPOSE 4200
CMD ["node", "/app/main.js"]
