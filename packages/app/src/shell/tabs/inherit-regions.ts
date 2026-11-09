type Regions<R> = Readonly<Record<string, R | undefined>>

/**
 * The panel layout (side panel open, sizes) a new tab should start with: the one it was opened from, so starting or
 * switching sessions in a project keeps the preview where it was. A tab that already has its own layout keeps it.
 */
export function inheritedRegions<R>(regions: Regions<R>, from: string, to: string): R | undefined {
  if (from === to || regions[to] !== undefined) return undefined

  return regions[from]
}
