/** The Settings pages for the providers and models an admin shares with everyone, and the users they manage. */
export function sharedSettingsTabs(input: { multiUser: boolean; admin: boolean }) {
  return input.multiUser && input.admin ? (["shared-providers", "shared-models", "users"] as const) : []
}
