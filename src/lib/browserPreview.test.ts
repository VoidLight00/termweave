import { describe, expect, test } from "bun:test";
import { developmentPortUrl, FRAME_NOTICE, PREVIEW_SANDBOX, validatePreviewUrl } from "./browserPreview.ts";
const local = { appUrl: "http://127.0.0.1:7317/", machineId: "local" };
describe("browser preview security policy", () => {
  test("only explicit http(s), no credentials, control characters or backslash", () => {
    for (const value of ["javascript:alert(1)", "data:text/html,x", "file:///tmp/x", "ftp://x.com", "blob:https://x.com/id", "//x.com", "/api/session", "https://u:" + "p@x.com", "http://", "https://x.com/\nx", "https://x.com\\@y.com", "https://x.com/ x"]) // leakscan:allow: test fixture
      expect(validatePreviewUrl(value, local).ok).toBe(false);
    expect(validatePreviewUrl("https://example.com/path?q=ok#next", local)).toMatchObject({ ok: true, canFrame: true });
  });
  test("app origin and default herdr port external only", () => {
    expect(validatePreviewUrl("http://127.0.0.1:7317/api/session", local)).toMatchObject({ ok: true, canFrame: false });
    expect(validatePreviewUrl("https://another-pc:7317/", local)).toMatchObject({ ok: true, canFrame: false });
  });
  test("mixed content external only; unknown framing remains unknown", () => {
    expect(validatePreviewUrl("http://example.com", { ...local, appUrl: "https://pc.example/" })).toMatchObject({ ok: true, canFrame: false });
    expect(FRAME_NOTICE).toBe("preview-frame-notice");
    expect(PREVIEW_SANDBOX).toBe("allow-scripts");
  });
  test("localhost never implicitly addresses a selected remote PC", () => {
    for (const machineId of ["remote-a", "remote-b", "../../local", "local@host"])
      expect(validatePreviewUrl("http://localhost:3000", { ...local, machineId })).toMatchObject({ ok: true, canFrame: false });
    expect(validatePreviewUrl("http://localhost:3000", { ...local, appUrl: "https://tailnet-pc.example/" })).toMatchObject({ ok: true, canFrame: false });
  });
  test("development ports explicitly limited to local loopback context", () => {
    expect(developmentPortUrl("3000", local)).toMatchObject({ ok: true, url: "http://127.0.0.1:3000/", canFrame: false });
    for (const port of ["0", "80", "1023", "65536", "7317", "3000/path", "3e3", "-1", " 3000", "3000.0"])
      expect(developmentPortUrl(port, local).ok).toBe(false);
    expect(developmentPortUrl("3000", { ...local, machineId: "remote-a" }).ok).toBe(false);
    expect(developmentPortUrl("3000", { ...local, appUrl: "http://100.64.0.10:7317" }).ok).toBe(false);
    expect(developmentPortUrl("3000", { ...local, appUrl: "http://localhost:3000" }).ok).toBe(false);
    expect(developmentPortUrl("3001", { ...local, appUrl: "http://[::1]:7317" })).toMatchObject({ ok: true, url: "http://[::1]:3001/" });
  });
});
