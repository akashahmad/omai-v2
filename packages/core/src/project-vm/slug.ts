const known: { value?: string } = {}

/**
 * The project's folder name on its VM (`<home>/<slug>`). A VM made for its project has it from the start
 * (`OMAI_PROJECT_SLUG`). A reserve VM boots before any project exists, so it asks the control plane, which names it
 * once a project claims the reserve; the name never changes after that. Undefined while unclaimed or unreachable.
 */
export async function slug(env: Record<string, string | undefined> = process.env) {
  if (env.OMAI_PROJECT_SLUG) return env.OMAI_PROJECT_SLUG
  if (known.value) return known.value
  const url = env.OMAI_CONTROL_PLANE_URL
  const projectID = env.OMAI_PROJECT_ID
  const token = env.OMAI_PROJECT_TOKEN
  if (!url || !projectID || !token) return undefined
  const answer = await fetch(`${url.replace(/\/+$/, "")}/internal/projects/${encodeURIComponent(projectID)}/vm`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  })
    .then((response) => (response.ok ? (response.json() as Promise<{ slug?: unknown }>) : undefined))
    .catch(() => undefined)
  // It becomes a folder name: anything but what the control plane's slugify makes is refused.
  if (typeof answer?.slug !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(answer.slug)) return undefined
  known.value = answer.slug
  return answer.slug
}
