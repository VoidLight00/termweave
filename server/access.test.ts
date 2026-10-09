import { describe, expect, it } from "bun:test";
import { cameThroughProxy, decideAccess, isLoopbackAddress, isLoopbackHost, type AccessInput } from "./access.ts";

const device = { id: "d1", label: "Phone", role: "drive" as const };
const base: AccessInput = { loopback: true, forwarded: false, funnel: false, tailscaleLogin: null, tokenMatched: false, device: null, owner: null, tagged: false, tokenConfigured: false, gated: false };
const via = (input: Partial<AccessInput>) => { const a = decideAccess({ ...base, ...input }); return a.level === "full" ? a.via : `refused:${a.reason}`; };

describe("decideAccess", () => {
  it("lets this PC in without a token, but not through a proxy", () => {
    expect(via({})).toBe("local");
    expect(via({ forwarded: true, gated: true })).toBe("refused:pairing_required");
  });

  it("lets this PC in past a token only when TERMWEAVE_TRUST_LOCAL opts in", () => {
    expect(via({ tokenConfigured: true })).toBe("refused:token_required");
    expect(via({ tokenConfigured: true, trustLocal: true })).toBe("local");
    expect(via({ tokenConfigured: true, trustLocal: true, forwarded: true })).toBe("refused:token_required");
    expect(via({ tokenConfigured: true, trustLocal: true, loopback: false })).toBe("refused:token_required");
  });

  it("denies external and proxied access without token or device", () => {
    expect(via({ loopback: false })).toBe("refused:pairing_required");
    expect(via({ loopback: true, forwarded: true })).toBe("refused:pairing_required");
    expect(via({ loopback: false, gated: true })).toBe("refused:pairing_required");
  });

  it("never treats a Funnel request as open", () => {
    expect(via({ loopback: true, forwarded: true, funnel: true })).toBe("refused:pairing_required");
    expect(via({ loopback: true, forwarded: true, funnel: true, device })).toBe("device");
  });

  it("trusts the PC's own Tailscale login only from the local tailscaled", () => {
    expect(via({ forwarded: true, tailscaleLogin: "me@example.com", owner: "me@example.com" })).toBe("tailscale");
    expect(via({ forwarded: true, tailscaleLogin: "Me@Example.com", owner: "me@example.com" })).toBe("tailscale");
    expect(via({ forwarded: true, tailscaleLogin: "them@example.com", owner: "me@example.com", gated: true })).toBe("refused:other_user");
    expect(via({ forwarded: true, tailscaleLogin: "them@example.com", owner: "me@example.com" })).toBe("refused:other_user");
    // a LAN client can type any header: from off this machine it means nothing
    expect(via({ loopback: false, tailscaleLogin: "me@example.com", owner: "me@example.com", gated: true })).toBe("refused:pairing_required");
    // no login from tailscale serve is a tagged node, not a person: it pairs like any other device
    expect(via({ forwarded: true, owner: "me@example.com" })).toBe("refused:pairing_required");
    expect(via({ forwarded: true, owner: "me@example.com", device })).toBe("device");
    // no owner known yet: the header decides nothing either way
    expect(via({ forwarded: true, tailscaleLogin: "me@example.com", owner: null })).toBe("refused:pairing_required");
  });

  it("asks a tagged PC's visitors to pair, its owner included, and never calls them another user", () => {
    // the node names no person: there is no login to match, and none to be a stranger to
    expect(via({ forwarded: true, tagged: true, tailscaleLogin: "me@example.com" })).toBe("refused:pairing_required");
    expect(via({ forwarded: true, tagged: true })).toBe("refused:pairing_required");
    expect(via({ forwarded: true, tagged: true, tailscaleLogin: "me@example.com", tokenConfigured: true })).toBe("refused:token_required");
    expect(via({ forwarded: true, tagged: true, tailscaleLogin: "me@example.com", device })).toBe("device");
    expect(via({ tagged: true })).toBe("local");
    // a login header alone marks a proxy: with no owner to refuse it against, it must not pass for this PC
    expect(cameThroughProxy(new Headers({ host: "localhost:7317", "tailscale-user-login": "them@example.com" }))).toBe(true);
    // a login named for the PC lets that person in as on any other node
    expect(via({ forwarded: true, tailscaleLogin: "me@example.com", owner: "me@example.com" })).toBe("tailscale");
  });

  it("a configured token gates everything but a paired device, this PC and its Tailscale login included", () => {
    expect(via({ tokenConfigured: true })).toBe("refused:token_required");
    expect(via({ tokenConfigured: true, tokenMatched: true })).toBe("token");
    expect(via({ tokenConfigured: true, device })).toBe("device");
    // any proxy on this PC can pass a visitor's copy of the login header on: a token holds against it
    expect(via({ tokenConfigured: true, forwarded: true, tailscaleLogin: "me@example.com", owner: "me@example.com" })).toBe("refused:token_required");
    expect(via({ tokenConfigured: true, forwarded: true, tailscaleLogin: "them@example.com", owner: "me@example.com" })).toBe("refused:token_required");
    expect(via({ tokenConfigured: true, tokenMatched: true, forwarded: true, tailscaleLogin: "me@example.com", owner: "me@example.com" })).toBe("token");
    expect(via({ tokenConfigured: true, device, forwarded: true, tailscaleLogin: "me@example.com", owner: "me@example.com" })).toBe("device");
  });

  it("a paired device gets in from anywhere, with its role", () => {
    const access = decideAccess({ ...base, loopback: false, gated: true, device: { ...device, role: "watch" } });
    expect(access).toEqual({ level: "full", via: "device", role: "watch", device: { ...device, role: "watch" } });
  });

  it("knows a name for this machine from a proxied Host", () => {
    for (const host of ["localhost", "localhost:7317", "LOCALHOST:5173", "herdr.localhost:7317", "127.0.0.1:7317", "127.9.9.9", "[::1]:7317", "localhost.:7317", "[::ffff:127.0.0.1]:7317"]) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ["app.example.test", "app.example.test:8443", "192.168.0.10:7317", "localhost.example.test", "127.0.0.1.example.test", "[fd7a::1]:7317", "", "0.0.0.0:7317", "[::ffff:192.168.0.10]"]) expect(isLoopbackHost(host)).toBe(false);
    // not an authority: a URL parser would have read these as localhost
    for (const host of ["public.example@localhost:7317", "localhost/x@public.example", "localhost:7317/x", "localhost?x", "local host", "localhost:port", "localhost..", "127.0.0.1@public.example"]) expect(isLoopbackHost(host)).toBe(false);
  });

  it("sees a proxy in a forwarding header or in a Host that is not this machine", () => {
    const proxy = (headers: Record<string, string>) => cameThroughProxy(new Headers(headers));
    expect(proxy({ host: "localhost:7317" })).toBe(false);
    expect(proxy({ host: "127.0.0.1:7317", origin: "http://127.0.0.1:7317" })).toBe(false);
    // no Host at all: HTTP/1.0 through a proxy, never a local browser or CLI
    expect(proxy({})).toBe(true);
    expect(proxy({ host: "public.example@localhost:7317" })).toBe(true);
    expect(proxy({ host: "app.example.test" })).toBe(true);
    for (const name of ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded", "via"]) expect(proxy({ host: "127.0.0.1:7317", [name]: "x" })).toBe(true);
  });

  it("knows loopback addresses in every spelling", () => {
    for (const address of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) expect(isLoopbackAddress(address)).toBe(true);
    for (const address of ["192.168.0.10", "100.64.0.2", "::ffff:192.168.0.10", "fd7a::1"]) expect(isLoopbackAddress(address)).toBe(false);
  });
});
