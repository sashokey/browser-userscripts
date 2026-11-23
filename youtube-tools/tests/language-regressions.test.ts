import assert from "node:assert/strict";
import { test } from "node:test";
import { feedbackLabels } from "../src/language.ts";

void test("feedback recognizes the Spanish native channel action without an icon", (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    value: { documentElement: { lang: "es-ES" } },
    configurable: true,
  });
  t.after(() => {
    if (descriptor) Reflect.defineProperty(globalThis, "document", descriptor);
    else Reflect.deleteProperty(globalThis, "document");
  });
  assert.ok(feedbackLabels("channel").includes("No recomendarme este canal"));
});
