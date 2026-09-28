import { afterEach, expect, test, vi } from "vitest";
import { scriptedLogin } from "../../../src/auth/import.js";
import { QaError } from "../../../src/errors/qa-error.js";
import type { Locator } from "../../../src/flows/schema.js";
import * as browserRuntime from "../../../src/playwright/runtime.js";

const USERNAME_ENV = "QA_UNIT_IMPORT_USERNAME";
const PASSWORD_ENV = "QA_UNIT_IMPORT_PASSWORD";
const USERNAME = "unit-import-username";
const PASSWORD = "unit-import-password";

const USERNAME_LOCATOR: Locator = { type: "css", selector: "#username" };
const PASSWORD_LOCATOR: Locator = { type: "css", selector: "#password" };
const SUBMIT_LOCATOR: Locator = { type: "css", selector: "#submit" };

afterEach(() => {
  delete process.env[USERNAME_ENV];
  delete process.env[PASSWORD_ENV];
  vi.restoreAllMocks();
});

test("an empty username throws AUTH_MISSING and does not launch a browser", async () => {
  process.env[USERNAME_ENV] = "";
  process.env[PASSWORD_ENV] = PASSWORD;
  const startBrowser = stubBrowser();

  const error = await missingCredential();

  expect(error).toBeInstanceOf(QaError);
  expect(error.code).toBe("AUTH_MISSING");
  expect(error.message).toBe(`Environment variable ${USERNAME_ENV} is not set`);
  expect(error.message).not.toContain(PASSWORD);
  expect(JSON.stringify(error.toJSON())).not.toContain(PASSWORD);
  expect(startBrowser).not.toHaveBeenCalled();
});

test("an empty password throws AUTH_MISSING and does not launch a browser", async () => {
  process.env[USERNAME_ENV] = USERNAME;
  process.env[PASSWORD_ENV] = "";
  const startBrowser = stubBrowser();

  const error = await missingCredential();

  expect(error).toBeInstanceOf(QaError);
  expect(error.code).toBe("AUTH_MISSING");
  expect(error.message).toBe(`Environment variable ${PASSWORD_ENV} is not set`);
  expect(error.message).not.toContain(USERNAME);
  expect(JSON.stringify(error.toJSON())).not.toContain(USERNAME);
  expect(startBrowser).not.toHaveBeenCalled();
});

function stubBrowser() {
  return vi.spyOn(browserRuntime, "startBrowser").mockRejectedValue(
    new Error("unit test must not launch a browser"),
  );
}

async function missingCredential(): Promise<QaError> {
  try {
    await scriptedLogin({
      projectId: "billing",
      profile: "worker",
      loginUrl: "http://localhost/login",
      usernameEnv: USERNAME_ENV,
      passwordEnv: PASSWORD_ENV,
      usernameLocator: USERNAME_LOCATOR,
      passwordLocator: PASSWORD_LOCATOR,
      submitLocator: SUBMIT_LOCATOR,
    });
  } catch (error) {
    if (error instanceof QaError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected AUTH_MISSING");
}
