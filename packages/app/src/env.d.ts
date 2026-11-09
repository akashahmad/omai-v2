/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OMAI_SERVER_MODE?: "none" | "origin"
  readonly VITE_OMAI_SERVER_HOST: string
  readonly VITE_OMAI_SERVER_PORT: string
  readonly VITE_OMAI_CHANNEL?: "local" | "dev" | "beta" | "prod"
  /** The control plane's address. Setting it switches the app to multi-user mode. */
  readonly VITE_OMAI_API_URL?: string
  /** Browser inactivity before logout in multi-user mode. Default 900000 (15 minutes). */
  readonly VITE_OMAI_SESSION_IDLE_MS?: string

  readonly VITE_SENTRY_DSN?: string
  readonly VITE_SENTRY_ENVIRONMENT?: string
  readonly VITE_SENTRY_RELEASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "*.png" {
  const src: string
  export default src
}

declare module "*.mp4" {
  const src: string
  export default src
}

export declare module "solid-js" {
  namespace JSX {
    interface Directives {
      sortable: true
    }

    // The Element Timing attribute, which Solid's DOM types do not list.
    interface ImgHTMLAttributes<T> {
      elementtiming?: string
    }
  }
}
