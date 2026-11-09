/** The Settings pages for the providers and models an admin shares with everyone. */
export function sharedSettingsTabs(input: { multiUser: boolean; admin: boolean }) {
  return input.multiUser && input.admin ? (["shared-providers", "shared-models"] as const) : []
}
