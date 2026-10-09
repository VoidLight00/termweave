/** Bounded metadata probes. No command shell and no raw diagnostics sent to clients. */
export async function metadataProcess(args: string[], env?: Record<string, string | undefined>): Promise<{out:string;err:string;code:number} | null> {
  const child = Bun.spawn(args, {stdin:"ignore",stdout:"pipe",stderr:"pipe",env:env ?? process.env});
  let overflow = false;
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) {
        const item = await reader.read(); if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > 256 * 1024) { overflow = true; child.kill("SIGKILL"); break; }
        chunks.push(item.value);
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks).toString("utf8");
  };
  const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
  const [out, err, code] = await Promise.all([read(child.stdout), read(child.stderr), child.exited]).finally(() => clearTimeout(timer));
  return overflow || child.signalCode ? null : {out,err,code};
}
