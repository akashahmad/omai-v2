export * as ProjectVmGateway from "./gateway.js"

/** What a VM holds in place of a secret it must not have: `omai-gw.<ref>` (`s~<integration>` or `u~<credential>`). */
export const STAND_IN = "omai-gw."
export const standIn = (ref: string) => `${STAND_IN}${ref}`
const FIND = /omai-gw\.([su]~[A-Za-z0-9_.:-]+)/

// A stand-in sign-in never expires on the VM, so the VM never refreshes it; the control plane does.
export const NEVER = 253_402_300_799_000

export type Target = { url: string; projectID: string; token: string }

/**
 * Sends every request that carries a stand-in, in its address or a header, to the control plane's gateway, which puts
 * the real secret in and calls the provider. It wraps `fetch` itself, so it covers every caller: the model SDKs and a
 * provider's own calls (model lists, token exchanges). Anything else goes out unchanged.
 */
export function wrap(original: typeof globalThis.fetch, target: Target): typeof globalThis.fetch {
  const base = `${target.url.replace(/\/+$/, "")}/internal/projects/${encodeURIComponent(target.projectID)}/gateway`
  const wrapped = (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const ref = find(input, init)
    if (!ref) return original(input, init)
    const request = new Request(input, init)
    const url = new URL(request.url)
    const headers = new Headers(request.headers)
    headers.set("x-omai-project-token", target.token)
    const origin = Buffer.from(url.origin).toString("base64url")
    return original(`${base}/${encodeURIComponent(ref)}/${origin}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: request.body,
      signal: request.signal,
      redirect: request.redirect,
      // Streams the body on, as model requests and uploads may be large.
      ...(request.body ? { duplex: "half" } : {}),
    } as RequestInit)
  }
  return Object.assign(wrapped, original)
}

/** On a project's MicroVM: routes stand-in requests through the gateway for the rest of the process. */
export function install(target: Target) {
  globalThis.fetch = wrap(globalThis.fetch, target)
}

/** The stand-in's ref, looked up without reading the body (it may be a one-time stream). */
function find(input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) {
  const url = input instanceof Request ? input.url : String(input)
  const inURL = FIND.exec(decodeURIComponent(url))?.[1]
  if (inURL) return inURL
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  for (const [, value] of headers) {
    const found = FIND.exec(value)?.[1]
    if (found) return found
  }
  return undefined
}
