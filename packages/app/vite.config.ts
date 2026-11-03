import { sentryVitePlugin } from "@sentry/vite-plugin"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import desktopPlugin, { channel } from "./vite.js"
import { icons } from "./vite.icons.ts"
import { serviceWorker } from "./vite.pwa.ts"

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./dist/**",
          filesToDeleteAfterUpload: "./dist/**/*.map",
        },
      })
    : false

export default defineConfig({
  plugins: [
    desktopPlugin,
    icons(channel),
    serviceWorker(fileURLToPath(new URL("./dist", import.meta.url))),
    sentry,
  ] as any,
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3000,
  },
  build: {
    ...(process.env.VITE_OMAI_TEST_FIXTURES === "1"
      ? {
          rolldownOptions: {
            input: [
              "index.html",
              "e2e/utils/app-direction.html",
              "e2e/utils/windows-menu.html",
            ],
          },
        }
      : {}),
    assetsDir: "_assets",
    target: "esnext",
    // Maps carry the original source, so they are only generated, and kept off the public bundle, for Sentry uploads.
    sourcemap: sentry ? "hidden" : false,
  },
})
