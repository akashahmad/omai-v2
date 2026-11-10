/**
 * Who a VM is for, for people reading the provider's console. A reserve has no project name until it is claimed. The
 * platform server's VM, not a project's, has none.
 */
export type VmLabel = { type: "vm" | "reserve"; projectName?: string; userName: string }

export type VmSpec = { projectID: string; slug: string; label?: VmLabel; env: Record<string, string> }

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
  /**
   * Deletes the VM and its volume for good. Only ever called for an unclaimed reserve. It derives every name from the
   * project ID itself, never takes a VM ID, and does nothing to anything outside this control plane's own names.
   * Idempotent: anything already gone is skipped.
   */
  destroy(projectID: string): Promise<void>
  /** Updates the label a VM was created with, after a claim or a rename. */
  label(vmID: string, projectID: string, label: VmLabel): Promise<void>
  /** The VMs this provider created that are running now. */
  list(): Promise<string[]>
}
