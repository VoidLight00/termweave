import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from './index.ts';
import { DeviceStore } from './devices.ts';
import { DEVICE_COOKIE } from './auth.ts';
import { OpenRigRuntime } from './openrig/runtime.ts';
import { OpenRigService } from './openrig-service.ts';

it('OpenRig routes enforce app authentication, watch access and origin before upstream calls', async () => {
  const root = mkdtempSync(join(tmpdir(), 'or-auth-'));
  const store = new DeviceStore(root);
  const watcher = store.pair(store.startPairing().code, 'Synthetic watcher', 'watch')!;
  let calls = 0;
  const runtime = new OpenRigRuntime({fetch: async (url) => {
    calls++;
    if (url.endsWith('/api/ps')) return Response.json([]);
    if (url.endsWith('/api/terminal/views')) return Response.json({rigs: [], saved: []});
    if (url.includes('/api/terminal/status')) return Response.json({providers: [{name: 'herdr', status: {available: true}, liveness: {alive: true}}]});
    throw new Error('Unexpected upstream operation');
  }});
  const controls: string[] = [];
  let running = true;
  const service = new OpenRigService(root, async (action) => { controls.push(action); if (action !== 'status') running = action === 'start'; return {available: true, running}; });
  const server = createServer({port: 0, stateDir: root, token: 'synthetic-openrig-test', tailscaleOwner: null, machines: false, openrig: runtime, openrigService: service});
  const base = `http://127.0.0.1:${server.port}`;
  const authorization = 'Bearer synthetic-openrig-test';
  try {
    expect((await fetch(base+'/api/openrig')).status).toBe(401);
    expect(calls).toBe(0);
    const watch = {cookie: `${DEVICE_COOKIE}=${watcher.token}`};
    const overview = await fetch(base+'/api/openrig', {headers: watch});
    expect(overview.status).toBe(200);
    expect((await overview.json()).teams).toEqual([]);
    const before = calls;
    expect((await fetch(base+'/api/openrig/open', {method:'POST',headers:{...watch,origin:base,'content-type':'application/json'},body:'{}'})).status).toBe(403);
    expect((await fetch(base+'/api/openrig/open', {method:'POST',headers:{authorization,origin:'https://untrusted.invalid','content-type':'application/json'},body:'{}'})).status).toBe(403);
    expect(calls).toBe(before);
    const unknown = await fetch(base+'/api/openrig/arbitrary', {headers:{authorization}});
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('cache-control')).toBe('no-store');
    for (const headers of [{...watch,origin:base}, {authorization,origin:'https://untrusted.invalid'}] as Record<string,string>[]) {
      expect((await fetch(base+'/api/openrig/service', {method:'POST',headers:{...headers,'content-type':'application/json'},body:'{"enabled":false}'})).status).toBe(403);
    }
    expect(controls).toEqual([]);
    const serviceRequest = (body: string) => fetch(base+'/api/openrig/service', {method:'POST',headers:{authorization,origin:base,'content-type':'application/json'},body});
    expect((await serviceRequest('{"enabled":false,"command":"anything"}')).status).toBe(400);
    expect((await serviceRequest('{"enabled":false}')).status).toBe(200);
    expect((await fetch(base+'/api/openrig', {headers:{authorization}})).status).toBe(409);
    expect(calls).toBe(before);
    expect(controls).toEqual(['stop']);
    expect((await serviceRequest('{"enabled":true}')).status).toBe(200);
    expect((await fetch(base+'/api/openrig', {headers:{authorization}})).status).toBe(200);
    expect(controls).toEqual(['stop','start']);
  } finally {server.stop(); rmSync(root,{recursive:true,force:true});}
});

it('service off is allowed while read-only provider readiness is pending', async () => {
  const root = mkdtempSync(join(tmpdir(), 'or-readiness-'));
  let entered!: () => void; let finish!: () => void;
  const active = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const runtime = new OpenRigRuntime();
  runtime.starter.readiness = async () => { entered(); await pending; return {checkedAt:new Date().toISOString(),ready:true,providers:[],blockers:[]}; };
  const controls: string[] = [];
  const service = new OpenRigService(root, async action => { controls.push(action); return {available:true,running:action!=='stop'}; });
  const server = createServer({port:0,stateDir:root,token:'synthetic-readiness-test',tailscaleOwner:null,machines:false,openrig:runtime,openrigService:service});
  const base = `http://127.0.0.1:${server.port}`;
  const headers = {authorization:'Bearer synthetic-readiness-test',origin:base,'content-type':'application/json'};
  try {
    const read = fetch(base+'/api/openrig/starter/readiness',{headers});await active;
    const off = await fetch(base+'/api/openrig/service',{method:'POST',headers,body:'{"enabled":false}'});
    expect(off.status).toBe(200);expect(await off.json()).toMatchObject({enabled:false,running:false});expect(controls).toEqual(['stop']);
    finish();expect((await read).status).toBe(200);
  } finally { finish();server.stop();rmSync(root,{recursive:true,force:true}); }
});

it('a slow service request cannot stop OpenRig after a team operation starts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'or-race-'));
  let finish!: () => void;
  let entered!: () => void;
  const active = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  const runtime = new OpenRigRuntime();
  runtime.open = async () => { entered(); await blocked; return {ok:true,outcome:'complete',opened:[],absent:[],degraded:[],pages:0}; };
  const controls: string[] = [];
  const service = new OpenRigService(root, async action => { controls.push(action); return {available:true,running:action!=='stop'}; });
  const server = createServer({port:0,stateDir:root,token:'synthetic-race-test',tailscaleOwner:null,machines:false,openrig:runtime,openrigService:service});
  const base = `http://127.0.0.1:${server.port}`;
  let body!: ReadableStreamDefaultController<Uint8Array>;
  try {
    const slow = fetch(base+'/api/openrig/service', {method:'POST',headers:{authorization:'Bearer synthetic-race-test',origin:base,'content-type':'application/json'},body:new ReadableStream({start(controller) {body=controller; controller.enqueue(new TextEncoder().encode('{"enabled":'));}})});
    await Bun.sleep(50); // Let the local HTTP parser enter its bounded-body read.
    const team = fetch(base+'/api/openrig/open', {method:'POST',headers:{authorization:'Bearer synthetic-race-test',origin:base,'content-type':'application/json'},body:JSON.stringify({view:'owned-view',expectedPlan:'owned-plan',requestId:'owned-request'})});
    await active;
    body.enqueue(new TextEncoder().encode('false}')); body.close();
    expect((await slow).status).toBe(409);
    expect(controls).toEqual([]);
    finish(); expect((await team).status).toBe(200);
  } finally { finish(); server.stop(); rmSync(root,{recursive:true,force:true}); }
});
