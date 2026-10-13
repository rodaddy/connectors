/** Smoke test: the package entry point loads and names itself. */
import { test } from "node:test";
import { expect } from "expect";

import { SDK_NAME } from "../src/index.ts";

// node:test registers the test and returns a promise the runner owns.
void test("SDK_NAME is the published package name", () => {
  expect(SDK_NAME).toBe("@rodaddy/connectors-highlevel");
});
