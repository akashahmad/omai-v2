import { expect, test } from "bun:test"
import { Env } from "../src/env"

test("session environment omits server credentials", () => {
  const previousPassword = process.env.OMAI_PASSWORD
  const previousLegacyPassword = process.env.OMAI_SERVER_PASSWORD
  const previousValue = process.env.OMAI_SESSION_ENV_TEST
  process.env.OMAI_PASSWORD = "password"
  process.env.OMAI_SERVER_PASSWORD = "legacy"
  process.env.OMAI_SESSION_ENV_TEST = "included"

  const environment = Env.session()

  if (previousPassword === undefined) delete process.env.OMAI_PASSWORD
  else process.env.OMAI_PASSWORD = previousPassword
  if (previousLegacyPassword === undefined) delete process.env.OMAI_SERVER_PASSWORD
  else process.env.OMAI_SERVER_PASSWORD = previousLegacyPassword
  if (previousValue === undefined) delete process.env.OMAI_SESSION_ENV_TEST
  else process.env.OMAI_SESSION_ENV_TEST = previousValue

  expect(environment.OMAI_PASSWORD).toBeUndefined()
  expect(environment.OMAI_SERVER_PASSWORD).toBeUndefined()
  expect(environment.OMAI_SESSION_ENV_TEST).toBe("included")
})
