import { expect, test } from "bun:test";
import { terminalLink } from "./terminalAddress.ts";
test("link keeps exact encoded routing and strips credentials and unrelated URL data", () => {
  const link = new URL(terminalLink("https://user:" + "secret@example.com/app/?token=secret&detached=1#secret", "remote / PC", "w:tab/%1")); // leakscan:allow: test fixture
  expect(link.username).toBe(""); expect(link.password).toBe(""); expect(link.hash).toBe("");
  expect(link.pathname).toBe("/app/");
  expect([...link.searchParams]).toEqual([["machine", "remote / PC"], ["pane", "w:tab/%1"]]);
});
