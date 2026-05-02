import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applyStreamingUpdates } from "./use-thread-messages";

const FIXTURES_DIR = join(import.meta.dirname!, "__fixtures__");

type Fixture = {
  description: string;
  logLine: number;
  messages: Parameters<typeof applyStreamingUpdates>[0];
  streamingUpdates: Parameters<typeof applyStreamingUpdates>[1];
};

const fixtureFiles = readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

describe("applyStreamingUpdates", () => {
  for (const file of fixtureFiles) {
    const fixture: Fixture = JSON.parse(readFileSync(join(FIXTURES_DIR, file), "utf-8"));

    it(`${fixture.description} (log line ${fixture.logLine})`, async () => {
      const result = await applyStreamingUpdates(fixture.messages, fixture.streamingUpdates);
      expect(result).toMatchSnapshot();
    });
  }
});
