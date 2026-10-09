/** Android mirrors belong to the web server's Mac, not the browser's machine. */
export type MirrorMode = "standard" | "light" | "screen-off";
export type AndroidState = "offline" | "pairing_required" | "ready" | "connecting" | "streaming" | "reconnecting" | "action_required" | "error";
export interface AndroidDevice {
  id: string; name: string; model: string; androidVersion: string;
  registered: boolean; transport: "usb" | "wifi"; state: AndroidState;
}
export interface MirrorSession {
  id: string; deviceId: string; mode: MirrorMode;
  state: "connecting" | "running" | "stopped" | "error";
  startedAt: string; error: string | null;
}
export interface AndroidOverview {
  host: "server"; available: { adb: boolean; scrcpy: boolean };
  devices: AndroidDevice[]; sessions: MirrorSession[];
  unattended: { status: "not_verified"; reason: "physical_device_test_required" };
}
