import { expect, it } from "bun:test";
import { autoPaneLabel, autoPaneNumber } from "./pane-label.ts";

it("reads the number of an automatic label and nothing else", () => {
  expect(autoPaneNumber("pane 1")).toBe(1);
  expect(autoPaneNumber("pane 12")).toBe(12);
  expect(autoPaneNumber(autoPaneLabel(7))).toBe(7);
  for (const own of ["", " pane 2", "Pane 2", "pane 0", "pane 02", "pane 2 old", "build", null, undefined]) expect(autoPaneNumber(own)).toBeNull();
});
