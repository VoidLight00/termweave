import { MobileRelayHub, type Role } from "./hub";
/** Private development entry. A separately approved TLS reverse proxy is needed for LTE. */
export function startMobileRelay(options: { deviceToken: string; viewerToken: string; expiresAt: number; port?: number; onRevoke?: () => void; pairing?: (request: Request) => Promise<Response>; health?: () => unknown; download?: (request: Request) => Response }) {
 const hub = new MobileRelayHub(options.deviceToken, options.viewerToken, options.expiresAt, Date.now, options.onRevoke);
 const server = Bun.serve<{ role: Role }>({
  hostname: "127.0.0.1", port: options.port ?? 7341,
  fetch(req, server) {
   const url = new URL(req.url);
   if (url.pathname === "/download/termweave-companion.apk" && options.download) return options.download(req);
   if (url.pathname === "/health" && req.method === "GET") return Response.json(options.health?.() ?? {ok:true},{headers:{"cache-control":"no-store"}});
   if (url.pathname === "/pair" && req.method === "POST" && !req.headers.has("origin") && options.pairing) return options.pairing(req);
   if (url.pathname !== "/connect" || req.headers.has("origin")) return new Response("Not found", {status:404});
   const role=url.searchParams.get("role") ?? "";
   const auth=req.headers.get("authorization") ?? "";
   if (!auth.startsWith("Bearer ") || !hub.authenticate(role, auth.slice(7))) return new Response("Unauthorized",{status:401});
   return server.upgrade(req,{data:{role}}) ? undefined : new Response("Upgrade required",{status:426});
  },
  websocket: {maxPayloadLength:1_048_576,backpressureLimit:1_048_576,closeOnBackpressureLimit:true,
   open(ws){hub.attach(ws.data.role,ws);}, message(ws,m){hub.receive(ws.data.role,ws,m);},close(ws){hub.detach(ws.data.role,ws);}
  }
 });
 return {server,hub,stop(){hub.close();server.stop(true);}};
}
