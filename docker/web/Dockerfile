# The web app: a static build served by nginx. The control plane's address is fixed at build time.
# Context: the repository root.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.4 AS build
ARG VITE_OMAI_API_URL
ARG VITE_OMAI_SESSION_IDLE_MS=900000
RUN test -n "$VITE_OMAI_API_URL" || (echo "VITE_OMAI_API_URL is required, e.g. https://api.omai.ch" && exit 1)
WORKDIR /src
COPY . .
RUN bun install --ignore-scripts
RUN cd packages/app \
  && OMAI_CHANNEL=prod VITE_OMAI_API_URL="$VITE_OMAI_API_URL" VITE_OMAI_SESSION_IDLE_MS="$VITE_OMAI_SESSION_IDLE_MS" bun run build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY docker/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/packages/app/dist /usr/share/nginx/html
EXPOSE 8080
