import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenRigService } from "./openrig-service.ts";

test("OpenRig explicit off persists and bridge restart cannot restart it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tw-openrig-switch-")); const calls: string[] = []; let running = true;
  const control = async (action: "status" | "start" | "stop") => { calls.push(action); if (action !== "status") running = action === "start"; return { available: true, running }; };
  try {
    const service = new OpenRigService(dir, control);
    expect(await service.setEnabled(false)).toMatchObject({ enabled: false, running: false });
    expect(statSync(join(dir, "openrig-service.json")).mode & 0o777).toBe(0o600);
    const restored = new OpenRigService(dir, control); await restored.restore();
    expect(restored.enabled).toBe(false); expect(calls).toEqual(["stop"]);
    expect(await restored.setEnabled(true)).toMatchObject({ enabled: true, running: true });
    await new OpenRigService(dir, control).restore(); expect(calls).toEqual(["stop", "start", "start"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("OpenRig failed stop keeps off intent but reports live process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tw-openrig-switch-"));
  try {
    const service = new OpenRigService(dir, async () => ({ available: true, running: true, error: "service_control_failed" }));
    await expect(service.setEnabled(false)).rejects.toThrow("service_control_failed");
    expect(await service.status()).toMatchObject({ enabled: false, running: true, error: "service_control_failed" });
    expect(JSON.parse(readFileSync(join(dir, "openrig-service.json"), "utf8")).enabled).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("OpenRig rejects overlapping changes and corrupt state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tw-openrig-switch-")); let release!: () => void;
  try {
    const service = new OpenRigService(dir, async () => { await new Promise<void>(r => { release = r; }); return { available: true, running: true }; });
    const first = service.setEnabled(true); await expect(service.setEnabled(false)).rejects.toThrow("service_busy"); release(); await first;
    writeFileSync(join(dir, "openrig-service.json"), "broken");
    const corrupt = new OpenRigService(dir, async () => { throw new Error("must not call"); });
    expect(corrupt.enabled).toBe(false); await expect(corrupt.setEnabled(true)).rejects.toThrow("service_not_managed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
