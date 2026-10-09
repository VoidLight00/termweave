import { expect, it } from "bun:test";
import { composeTitle, folderName, placeLine, shortPathTitle } from "./paneName.ts";

it("shows a path title as its last folder, and leaves any other title alone", () => {
  expect(shortPathTitle("/tmp/audit-oDjsU2/lms-backend")).toBe("lms-backend");
  expect(shortPathTitle("/home/fixture/dev/api/")).toBe("api"); // leakscan:allow: test fixture
  expect(shortPathTitle("~/dev/herdr web ui")).toBe("herdr web ui");
  expect(shortPathTitle("~")).toBe("~");
  expect(shortPathTitle("/")).toBe("/");
  expect(shortPathTitle("C:\\Users\\fixture\\work\\site")).toBe("site");
  expect(shortPathTitle("C:\\")).toBe("C:\\");
  expect(shortPathTitle("fix the login bug")).toBe("fix the login bug");
  expect(shortPathTitle("vim /etc/hosts")).toBe("vim /etc/hosts");
  expect(shortPathTitle("~tilde-name")).toBe("~tilde-name");
});

it("says a workspace and its folder once when they are the same", () => {
  expect(placeLine("lms-backend", "lms-backend")).toBe("lms-backend");
  expect(placeLine("api", "server")).toBe("api · server");
  expect(placeLine("api", "")).toBe("api");
});

it("finds the folder of a Windows path as of a POSIX one", () => {
  expect(folderName("C:\\work\\api")).toBe("api");
  expect(folderName("C:\\work\\api\\")).toBe("api");
  expect(folderName("C:/work/api")).toBe("api");
  expect(folderName("\\\\server\\share\\api")).toBe("api");
  expect(folderName("C:\\")).toBe("C:\\");
  expect(folderName("C:/")).toBe("C:/");
  expect(folderName("/home/fixture/dev/api/")).toBe("api"); // leakscan:allow: test fixture
  expect(folderName("/")).toBe("/");
  expect(placeLine("api", folderName("C:\\work\\api"))).toBe("api");
  expect(placeLine("api", folderName("C:\\work\\server"))).toBe("api · server");
});

it("numbers the live title for an automatic label and leaves a chosen name alone", () => {
  expect(composeTitle("pane 2", "api")).toBe("2 · api");
  expect(composeTitle("pane 2", "")).toBe("pane 2");
  expect(composeTitle(" pane 3 ", "tmux")).toBe("3 · tmux");
  expect(composeTitle("deploy", "api")).toBe("deploy");
  expect(composeTitle("pane 02", "api")).toBe("pane 02");
  expect(composeTitle(null, "api")).toBe("api");
  expect(composeTitle(undefined, "")).toBe("");
});
