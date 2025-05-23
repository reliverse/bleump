import { relinka } from "@reliverse/relinka";
import { expect, test } from "bun:test";

test("test", () => {
  relinka("info", "tests: coming soon");
  expect(true).toBe(true);
});
