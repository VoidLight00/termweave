import {metadataProcess} from "./metadata-process.ts";

/** Inspect only a selected pane's process tree. Never probe ports or enumerate other processes' sockets. */
export async function listeningPorts(panePid: number): Promise<number[] | null> {
  const ps = Bun.which("ps"), lsof = Bun.which("lsof");
  if (!ps || !lsof || !Number.isSafeInteger(panePid) || panePid < 1) return null;
  try {
    const tree = await metadataProcess([ps,"-axo","pid=,ppid="]);
    if (!tree || tree.code) return null;
    const children = new Map<number, number[]>(); let rootExists = false;
    for (const line of tree.out.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line); if (!match) continue;
      const pid=Number(match[1]), parent=Number(match[2]);
      if (pid === panePid) rootExists = true;
      children.set(parent, [...(children.get(parent) ?? []), pid]);
    }
    if (!rootExists) return null;
    const selected = new Set<number>(); const todo = [panePid];
    while (todo.length) {
      const pid = todo.pop()!; if (selected.has(pid)) continue;
      selected.add(pid); if (selected.size > 128) return null;
      todo.push(...children.get(pid) ?? []);
    }
    const sockets = await metadataProcess([lsof,"-nP","-a","-p",[...selected].join(","),"-iTCP","-sTCP:LISTEN","-Fn"]);
    // lsof returns 1 when the selected processes have no matching sockets.
    if (!sockets || (sockets.code !== 0 && !(sockets.code === 1 && !sockets.out && !sockets.err))) return null;
    const ports = new Set<number>();
    for (const line of sockets.out.split("\n")) {
      const match = /^n.*:(\d+)$/.exec(line); if (!match) continue;
      const port=Number(match[1]); if (port > 0 && port <= 65535) ports.add(port);
    }
    return [...ports].sort((a,b) => a-b);
  } catch { return null; }
}
