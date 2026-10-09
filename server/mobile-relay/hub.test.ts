import { describe, expect, test } from "bun:test";
import { MobileRelayHub } from "./hub";
const D = "d".repeat(43), V = "v".repeat(43);
function peer() { return { messages: [] as (string | Uint8Array)[], closed: false, send(d: string | Uint8Array) { this.messages.push(d); }, close() { this.closed = true; } }; }
describe("mobile relay capability boundary", () => {
 test("invalid JSON shapes cannot crash the socket handler",()=>{const h=new MobileRelayHub(D,V,9999,()=>1000),d=peer();h.attach("device",d);for(const message of ["null","[]","42","broken"]){expect(h.receive("device",d,message)).toBe(false);}});
 test("separate credentials and revocation", () => {const h=new MobileRelayHub(D,V,9999,()=>1000);expect(h.authenticate("device",V)).toBe(false);expect(h.authenticate("viewer",V)).toBe(true);h.revoke();expect(h.authenticate("viewer",V)).toBe(false);});
 test("old epoch, replay, expired input and unsupported actions are rejected", () => {
  let now=1000;const h=new MobileRelayHub(D,V,9999,()=>now),d=peer(),v=peer();h.attach("device",d);h.attach("viewer",v);
  const streamId=JSON.parse(String(v.messages.at(-1))).streamId;
  const input={type:"input",streamId,seq:1,expiresAt:1100,action:"tap",x:.5,y:.5};
  expect(h.receive("viewer",v,JSON.stringify(input))).toBe(false);
  h.receive("device",d,JSON.stringify({type:"status",sharing:true,inputAllowed:true}));
  expect(h.receive("viewer",v,JSON.stringify(input))).toBe(true);now+=40;
  expect(h.receive("viewer",v,JSON.stringify(input))).toBe(false);
  expect(h.receive("viewer",v,JSON.stringify({...input,seq:2,expiresAt:999}))).toBe(false);
  expect(h.receive("viewer",v,JSON.stringify({...input,seq:2,action:"shell"}))).toBe(false);
  h.detach("viewer",v);const v2=peer();h.attach("viewer",v2);expect(h.receive("viewer",v2,JSON.stringify({...input,seq:2}))).toBe(false);
 });
 test("binary only flows from an active device, with bounded size",()=> {const h=new MobileRelayHub(D,V,9999,()=>1000),d=peer(),v=peer();h.attach("device",d);h.attach("viewer",v);const frame=new Uint8Array([255,216,255,217]);expect(h.receive("device",d,frame)).toBe(false);h.receive("device",d,JSON.stringify({type:"status",sharing:true}));expect(h.receive("device",d,frame)).toBe(true);expect(h.receive("viewer",v,frame)).toBe(false);h.revoke();expect(d.closed).toBe(true);});
 test("replaced peer cannot send or detach the new peer",()=> {const h=new MobileRelayHub(D,V,9999,()=>1000),d=peer(),d2=peer();h.attach("device",d);h.attach("device",d2);h.detach("device",d);expect(h.receive("device",d,JSON.stringify({type:"status",sharing:true}))).toBe(false);expect(h.receive("device",d2,JSON.stringify({type:"status",sharing:true}))).toBe(true);});
});
