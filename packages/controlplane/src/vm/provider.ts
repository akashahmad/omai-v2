export type VmSpec = { projectID: string; slug: string; env: Record<string, string> }

/**
 * `home` is the VM's home folder; the project lives at `<home>/<slug>`. `preview` is the preview's public origin, for
 * a provider that publishes the VM's preview port under its own address.
 */
export type VmAddress = { vmID: string; host: string; home: string; preview?: string }

export interface VmProvider {
  /** Idempotent per project. */
  create(spec: VmSpec): Promise<VmAddress>
  /** Starts the VM again if it stopped, keeping the environment it was created with. */
  ensureRunning(vmID: string): Promise<VmAddress>
  /** Stops the VM, keeping its volume. Idempotent; resolves once it no longer serves. */
  stop(vmID: string): Promise<void>
  /** The VMs this provider created that are running now. */
  list(): Promise<string[]>
}
