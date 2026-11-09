import { describe, expect, test } from "bun:test"
import { ControlPlaneConfig } from "../src/config.js"

const required = {
  OMAI_APP_ORIGIN: "http://localhost:4444",
  OMAI_TOKEN_SIGNING_KEY: "private",
  OMAI_TOKEN_PUBLIC_KEY: "public",
  OMAI_ROUTER_URL: "http://localhost:4200",
}

describe("ControlPlaneConfig", () => {
  test("config lists missing variables", () => {
    expect(() => ControlPlaneConfig.fromEnv({})).toThrow(
      /OMAI_APP_ORIGIN.*OMAI_TOKEN_SIGNING_KEY.*OMAI_TOKEN_PUBLIC_KEY.*OMAI_ROUTER_URL/s,
    )
  })

  test("an empty value counts as unset", () => {
    expect(() => ControlPlaneConfig.fromEnv({ ...required, OMAI_APP_ORIGIN: "" })).toThrow(/OMAI_APP_ORIGIN/)
  })

  test("config defaults", () => {
    const config = ControlPlaneConfig.fromEnv({ ...required, OMAI_DATABASE_URL: "" })
    expect(config.signupEnabled).toBe(false)
    expect(config.port).toBe(4100)
    expect(config.internalPort).toBe(4101)
    expect(config.sessionIdleMs).toBe(900_000)
    expect(config.vmWakeTimeoutMs).toBe(90_000)
    expect(config.databaseUrl).toBeUndefined()
    expect(config.localProjectsRoot.endsWith("vms")).toBe(true)
  })

  test("signup only with true", () => {
    expect(ControlPlaneConfig.fromEnv({ ...required, OMAI_SIGNUP_ENABLED: "1" }).signupEnabled).toBe(false)
    expect(ControlPlaneConfig.fromEnv({ ...required, OMAI_SIGNUP_ENABLED: "true" }).signupEnabled).toBe(true)
  })

  test("lifecycle defaults", () => {
    const config = ControlPlaneConfig.fromEnv(required)
    expect(config.vmIdleMs).toBe(120_000)
    expect(config.vmSweepMs).toBe(15_000)
    expect(config.vmBusyFreshMs).toBe(30_000)
    expect(config.vmUnreachableGraceMs).toBe(60_000)
    expect(config.vmReconcileMs).toBe(180_000)
  })

  test("lifecycle overrides", () => {
    expect(ControlPlaneConfig.fromEnv({ ...required, OMAI_VM_IDLE_MS: "5000" }).vmIdleMs).toBe(5000)
  })
})
