import { describe, expect, test } from "bun:test"
import { getProjectAvatarSource } from "./project-avatar"

describe("getProjectAvatarSource", () => {
  test("prefers a chosen image, then a chosen color, then the automatic icon", () => {
    expect(getProjectAvatarSource("abc", { override: "data:image/png;base64,AA==", url: "data:auto" })).toBe(
      "data:image/png;base64,AA==",
    )
    expect(getProjectAvatarSource("abc", { color: "blue", url: "data:auto" })).toBeUndefined()
    expect(getProjectAvatarSource("abc", { url: "data:auto" })).toBe("data:auto")
  })
})
