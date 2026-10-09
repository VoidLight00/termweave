import { describe, expect, it } from "bun:test";
import { deviceLabel, isLoopbackHost, phonePlan } from "./phone.ts";
import type { RemoteAccess } from "../../shared/protocol.ts";

const local = { protocol: "http:", hostname: "localhost", origin: "http://localhost:7317", secure: true };
const running = (patch: Partial<RemoteAccess["tailscale"]> = {}): RemoteAccess => ({
  port: 7317,
  tailscale: { state: "running", dns_name: "pc.example.ts.net", serving_url: null, serve_command: "tailscale serve --bg --https=443 http://127.0.0.1:7317", serve_url: "https://pc.example.ts.net", ...patch },
});

describe("phonePlan", () => {
  it("points at this page when it is already on an HTTPS address a phone can open", () => {
    const page = { protocol: "https:", hostname: "pc.example.ts.net", origin: "https://pc.example.ts.net", secure: true };
    expect(phonePlan(page, null)).toEqual({ kind: "here", url: "https://pc.example.ts.net" });
    expect(phonePlan(page, running({ state: "missing" }))).toEqual({ kind: "here", url: "https://pc.example.ts.net" });
  });

  it("treats localhost over HTTPS and any plain-HTTP page as not reachable from a phone", () => {
    expect(phonePlan({ protocol: "https:", hostname: "localhost", origin: "https://localhost:7317", secure: true }, null)).toEqual({ kind: "unknown" });
    expect(phonePlan({ protocol: "http:", hostname: "192.168.0.10", origin: "http://192.168.0.10:7317", secure: false }, running()).kind).toBe("command");
  });

  it("shows the address Tailscale already serves, else the command", () => {
    expect(phonePlan(local, running({ serving_url: "https://pc.example.ts.net:17317", serve_command: null, serve_url: null }))).toEqual({ kind: "served", url: "https://pc.example.ts.net:17317" });
    expect(phonePlan(local, running())).toEqual({ kind: "command", command: "tailscale serve --bg --https=443 http://127.0.0.1:7317", url: "https://pc.example.ts.net" });
    expect(phonePlan(local, running({ dns_name: null, serve_url: null }))).toEqual({ kind: "command", command: "tailscale serve --bg --https=443 http://127.0.0.1:7317", url: null });
  });

  it("reports what is in the way", () => {
    expect(phonePlan(local, running({ state: "stopped", dns_name: null, serve_command: null, serve_url: null }))).toEqual({ kind: "stopped" });
    expect(phonePlan(local, running({ state: "missing", dns_name: null, serve_command: null, serve_url: null }))).toEqual({ kind: "missing" });
    expect(phonePlan(local, null)).toEqual({ kind: "unknown" });
    expect(phonePlan(local, running({ serve_command: null, serve_url: null }))).toEqual({ kind: "unknown" });
  });

  it("knows the loopback names", () => {
    for (const host of ["localhost", "app.localhost", "127.0.0.1", "127.1.2.3", "[::1]"]) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ["pc.example.ts.net", "192.168.0.10", "localhost.example.com"]) expect(isLoopbackHost(host)).toBe(false);
  });
});

describe("deviceLabel", () => {
  it("names the device and browser", () => {
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1")).toBe("iPhone · Safari");
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36")).toBe("Mac · Chrome");
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15", 5)).toBe("iPad · Safari");
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36")).toBe("Android · Chrome");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36 Edg/128.0")).toBe("Windows · Edge");
    expect(deviceLabel("curl/8.0")).toBe("Device");
  });
});
