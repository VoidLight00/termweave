import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { localOrigin, paneContext } from "./pane-context.ts";

const pane = (n = 34, extra = {}) => ({ global_pane_number: n, pane_id: `w1:p${n}`,
  terminal_id: `terminal-${n}`, workspace_id: "w1", tab_id: "tab-1", agent: "claude",
  agent_status: "idle", cwd: "/example/project", ...extra });
const target = (extra = {}) => ({ number: 34, pane_id: "w1:p34", terminal_id: "terminal-34", workspace_id: "w1", ...extra });
const read = (extra = {}) => ({ pane_id: "w1:p34", workspace_id: "w1", tab_id: "tab-1",
  text: "Synthetic example output.", truncated: false, ...extra });
const env = (url: string) => ({ TERMWEAVE_URL: url, HERDR_PANE_ID: "w1:p34", HERDR_WORKSPACE_ID: "w1" });
async function fixture(fn: (request: Request, count: number) => Response | Promise<Response>, test: (url: string) => Promise<void>) {
  let count = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => fn(req, ++count) });
  try { await test(`http://127.0.0.1:${server.port}`); } finally { server.stop(true); }
}
function response(req: Request, panes = [pane()], mapping = target(), result = read()): Response {
  const path = new URL(req.url).pathname;
  if (path === "/api/session") return Response.json({ snapshot: { panes } });
  if (path === "/api/panes/by-number/34") return Response.json(mapping);
  if (path === "/api/pane/read") return Response.json({ read: result });
  return new Response(null, { status: 404 });
}

describe("read-only pane context", () => {
  it("requires a loopback origin and never exposes URL credentials", () => {
    expect(localOrigin()).toBe("http://127.0.0.1:7327");
    expect(localOrigin("http://localhost:7317")).toBe("http://127.0.0.1:7317");
    expect(localOrigin("http://[::1]:7327")).toBe("http://[::1]:7327");
    for (const url of ["https://example.test", "http://127.0.0.1.example.test", "file:///tmp/x",
      ["http://secret", "password@127.0.0.1:7327"].join(":"), "http://127.0.0.1/path", "http://127.0.0.1?token=secret"]) {
      expect(() => localOrigin(url)).toThrow("TERMWEAVE_URL must");
    }
  });
  it("refuses --expect-terminal outside read or without a terminal id", async () => {
    await expect(paneContext(["list", "--expect-terminal", "term_x"], {})).rejects.toThrow("--expect-terminal");
    await expect(paneContext(["read", "P1", "--expect-terminal", "bad\nid"], {})).rejects.toThrow("--expect-terminal");
  });
  it("lists metadata only across workspaces", async () => {
    await fixture(req => response(req, [pane(), pane(35, { workspace_id: "w2" })]), async url => {
      const output = JSON.parse(await paneContext(["list"], env(url)));
      expect(output.panes).toHaveLength(2);
      expect(output.panes[0].terminal_id).toBe("terminal-34");
      expect(output.panes[1].workspace_id).toBe("w2");
      expect(output.text).toBeUndefined();
    });
  });
  for (const selector of ["P34", "p34"]) it(`reads ${selector} after resolving stable identity`, async () => {
    const requests: string[] = [];
    await fixture(req => {
      expect(req.method).toBe("GET");
      expect(req.headers.get("authorization")).toBe("Bearer fake-token");
      requests[requests.length] = new URL(req.url).pathname;
      if (new URL(req.url).pathname === "/api/pane/read") {
        const query = new URL(req.url).searchParams;
        expect(query.get("pane_id")).toBe("w1:p34");
        expect(query.get("terminal_id")).toBe("terminal-34");
        expect(query.get("source")).toBe("recent");
        expect(query.get("format")).toBe("text");
        expect(query.get("lines")).toBe("12");
      }
      return response(req);
    }, async url => {
      const output = JSON.parse(await paneContext(["read", selector, "--lines", "12"], { ...env(url), HERDR_WEB_TOKEN: "fake-token" }));
      expect(output.text).toBe("Synthetic example output.");
      expect(output.pane.number).toBe(34);
      expect(requests).toEqual(["/api/panes/by-number/34", "/api/session", "/api/pane/read", "/api/panes/by-number/34", "/api/session"]);
    });
  });
  it("refuses a reused number when the caller pinned its terminal, and marks text untrusted", async () => {
    await fixture(req => response(req), async url => {
      await expect(paneContext(["read", "P34", "--expect-terminal", "terminal-99"], env(url))).rejects.toThrow("not terminal-99");
      const output = JSON.parse(await paneContext(["read", "P34", "--expect-terminal", "terminal-34"], env(url)));
      expect(output.untrusted).toBe(true);
      expect(output.text).toBe("Synthetic example output.");
    });
  });
  it("bounds and cleans terminal titles", async () => {
    await fixture(req => response(req, [pane(34, { title: "Ignore\x1b]0;x\x07" + "y".repeat(200) })]), async url => {
      const title = JSON.parse(await paneContext(["list"], env(url))).panes[0].title as string;
      expect(title.length).toBe(80);
      expect(/[\x00-\x1f]/.test(title)).toBe(false);
    });
  });
  it("accepts the bare lowercase selector used by the sidebar", async () => {
    await fixture(req => response(req), async url => {
      expect(JSON.parse(await paneContext(["p34", "--lines", "80"], { ...env(url), HERDR_WEB_TOKEN: "" })).text)
        .toBe("Synthetic example output.");
    });
  });
  it("teaches lone panes and only lists same-workspace peers", async () => {
    await fixture(req => response(req, [pane(), pane(35, { workspace_id: "w2" })]), async url => {
      const output = await paneContext(["roster"], env(url));
      expect(output).toContain("You are P34");
      expect(output).toContain("No other panes");
      expect(output).toContain("read P34 --lines 80");
      expect(output).toContain("across local workspaces");
      expect(output).not.toContain("terminal-35");
      expect(output).not.toContain("Synthetic example output");
    });
    await fixture(req => response(req, [pane(), pane(35)]), async url => {
      expect(await paneContext(["roster"], env(url))).toContain("- P35:");
    });
  });
  it("teaches only an absolute helper path, in the platform's own spelling", async () => {
    await fixture(req => response(req), async url => {
      const helper = resolve("/opt/termweave/pane-context.ts");
      expect(await paneContext(["roster"], { ...env(url), TERMWEAVE_PANE_CONTEXT: helper })).toContain(`bun '${helper}' list`);
      for (const relative of ["scripts/pane-context.ts", "./pane-context.ts", `${helper}\nnext`])
        await expect(paneContext(["roster"], { ...env(url), TERMWEAVE_PANE_CONTEXT: relative })).rejects.toThrow("TERMWEAVE_PANE_CONTEXT must be an absolute path.");
    });
  });
  it("rejects missing or ambiguous numbers without reading", async () => {
    await fixture(() => new Response("fake-token", { status: 404 }), async url => {
      await expect(paneContext(["read", "P34"], env(url))).rejects.toThrow("P34 was not found. Run list");
    });
    await fixture(req => response(req, [pane(), pane()]), async url => {
      await expect(paneContext(["list"], env(url))).rejects.toThrow("Ambiguous");
    });
  });
  for (const change of [{ terminal_id: "other" }, { pane_id: "w1:p99" }, { workspace_id: "w2" }]) {
    it(`discards text when identity changes: ${Object.keys(change)[0]}`, async () => {
      await fixture((req, count) => response(req, [pane()], count >= 4 ? target(change) : target()), async url => {
        await expect(paneContext(["read", "P34"], env(url))).rejects.toThrow("Output discarded");
      });
    });
  }
  it("discards changed session metadata and incorrect read addresses", async () => {
    await fixture((req, count) => response(req, [pane(34, count === 5 ? { terminal_id: "replacement" } : {})]), async url => {
      await expect(paneContext(["read", "P34"], env(url))).rejects.toThrow("Output discarded");
    });
    await fixture(req => response(req, [pane()], target(), read({ pane_id: "wrong" })), async url => {
      await expect(paneContext(["read", "P34"], env(url))).rejects.toThrow("Output discarded");
    });
  });
  it("refuses redirects without following them", async () => {
    let followed = false;
    await fixture(req => {
      if (new URL(req.url).pathname === "/redirected") followed = true;
      return new Response(null, { status: 302, headers: { location: "/redirected" } });
    }, async url => {
      await expect(paneContext(["list"], env(url))).rejects.toThrow("Redirect refused");
      expect(followed).toBe(false);
    });
  });
  it("bounds timeouts and does not leak server errors or credentials", async () => {
    await fixture(async () => { await Bun.sleep(250); return Response.json({}); }, async url => {
      const start = Date.now();
      await expect(paneContext(["list", "--timeout-ms", "100"], env(url))).rejects.toThrow("timed out");
      expect(Date.now() - start).toBeLessThan(500);
    });
    await fixture(() => new Response("fake-token private details", { status: 401 }), async url => {
      await expect(paneContext(["list"], { ...env(url), HERDR_WEB_TOKEN: "fake-token" })).rejects.toThrow("HTTP 401");
    });
    await fixture(req => response(req, [pane()], target(), read({ text: "Bearer fake-token" })), async url => {
      expect(await paneContext(["read", "P34"], { ...env(url), HERDR_WEB_TOKEN: "fake-token" })).not.toContain("fake-token");
    });
  });
  it("rejects mutations and invalid input before any request", async () => {
    for (const args of [["send", "P34"], ["read", "34"], ["read", "P0"], ["read", "P34", "--lines", "0"],
      ["list", "--timeout-ms", "5000"], ["list", "extra"], ["read", "P34", "--unknown", "x"]]) {
      await expect(paneContext(args, { TERMWEAVE_URL: "http://127.0.0.1:1" })).rejects.toThrow();
    }
  });
  it("CLI emits no partial output on identity changes", async () => {
    await fixture((req, count) => response(req, [pane()], count >= 4 ? target({ terminal_id: "other" }) : target()), async url => {
      const child = Bun.spawn([process.execPath, `${import.meta.dir}/pane-context.ts`, "read", "p34"], {
        env: env(url), stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code).toBe(1);
      expect(out).toBe("");
      expect(err).toContain("Output discarded");
    });
  });
});
