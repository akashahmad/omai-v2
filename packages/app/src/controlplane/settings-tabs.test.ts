import { describe, expect, test } from "bun:test"
import { sharedSettingsTabs } from "./settings-tabs"

describe("sharedSettingsTabs", () => {
  test("only admins in multi-user mode get the shared pages", () => {
    expect(sharedSettingsTabs({ multiUser: false, admin: false })).toEqual([])
    expect(sharedSettingsTabs({ multiUser: true, admin: false })).toEqual([])
    expect(sharedSettingsTabs({ multiUser: true, admin: true })).toEqual(["shared-providers", "shared-models"])
  })
})
