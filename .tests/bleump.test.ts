import { expect, test } from "bun:test";
import { relinka } from "@reliverse/relinka";

test("test", () => {
  relinka("info", "tests: coming soon");
  expect(true).toBe(true);
});
