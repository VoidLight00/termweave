import { expect, it } from "bun:test";
import { homedir } from "node:os";
import { userHome } from "./user-home.ts";

it("reads HOME first on every platform", () => {
  expect(userHome({ HOME: "/home/u", USERPROFILE: "C:\\Users\\u" }, "win32")).toBe("/home/u");
  expect(userHome({ HOME: "/home/u" }, "linux")).toBe("/home/u");
});

it("falls back to USERPROFILE, then the OS's answer, on Windows without HOME", () => {
  expect(userHome({ USERPROFILE: "C:\\Users\\u" }, "win32")).toBe("C:\\Users\\u");
  expect(userHome({ HOME: "", USERPROFILE: "C:\\Users\\u" }, "win32")).toBe("C:\\Users\\u");
  expect(userHome({}, "win32")).toBe(homedir());
});

it("leaves a missing HOME missing elsewhere, whatever USERPROFILE says", () => {
  expect(userHome({ USERPROFILE: "C:\\Users\\u" }, "linux")).toBe("");
  expect(userHome({}, "darwin")).toBe("");
});
