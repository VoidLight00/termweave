/** Copy only navigation coordinates, never authentication or arbitrary query parameters. */
export function terminalLink(base: string, machineId: string, paneId: string): string {
  const url = new URL(base);
  url.username = "";
  url.password = "";
  url.search = new URLSearchParams({ machine: machineId, pane: paneId }).toString();
  url.hash = "";
  return url.toString();
}
