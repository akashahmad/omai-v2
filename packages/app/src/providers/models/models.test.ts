import { expect, test } from "bun:test"
import { uniqueModels } from "./models"

test("uniqueModels keeps the first of each model in order", () => {
  expect(
    uniqueModels([
      { providerID: "a", modelID: "1" },
      { providerID: "b", modelID: "1" },
      { providerID: "a", modelID: "1" },
      { providerID: "a", modelID: "2" },
    ]),
  ).toEqual([
    { providerID: "a", modelID: "1" },
    { providerID: "b", modelID: "1" },
    { providerID: "a", modelID: "2" },
  ])
})
