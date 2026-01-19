import { convexTest } from "convex-test";
/// <reference types="vite/client" />
import { test } from "vitest";
export const modules = import.meta.glob("./**/*.*s");

import { type GenericSchema, type SchemaDefinition, defineSchema } from "convex/server";
import { componentsGeneric } from "convex/server";
import { type ComponentApi } from "../component/_generated/component.js";
import { register } from "../test.js";

export function initConvexTest<Schema extends SchemaDefinition<GenericSchema, boolean>>(schema?: Schema) {
  const t = convexTest(schema ?? defineSchema({}), modules);
  register(t);
  return t;
}
export const components = componentsGeneric() as unknown as {
  durable_agent: ComponentApi;
};

test("setup", () => {});
