import { homedir } from "node:os";

/**
 * The user's home, where agents keep their stores: HOME, else on Windows (which often sets no
 * HOME, and install.ps1 starts the server without one) USERPROFILE, else the OS's answer.
 * Elsewhere USERPROFILE means nothing, so a missing HOME stays missing there. Read, never written
 * back to the environment: Git and the other tools the server starts pick their own home on
 * Windows (HOMEDRIVE/HOMEPATH first).
 */
export function userHome(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): string {
  return env["HOME"] || (platform === "win32" ? env["USERPROFILE"] || homedir() : "");
}
