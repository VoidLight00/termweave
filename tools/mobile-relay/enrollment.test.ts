import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { pairingHandler, privateWrite, privateRead, revokeEnrollment, type Enrollment } from "./enrollment";
const token="d".repeat(43),viewer="v".repeat(43),code="ABCDEFGHIJKLMNOP".slice(0,12);
function fixture(){const root=mkdtempSync(join(tmpdir(),"tw-pair-"));privateWrite(join(root,"enrollment.json"),{deviceToken:token,viewerToken:viewer,expiresAt:9999,port:7339,revoked:false});privateWrite(join(root,"pairing.json"),{codeHash:createHash("sha256").update(code).digest("hex"),expiresAt:2000,used:false,attempts:0});return root;}
function request(value=code){return new Request("https://relay.invalid/pair",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code:value})});}
test("pairing is single use and does not disclose viewer credentials",async()=>{const root=fixture();try{const handle=pairingHandler(root,()=>1000);const r=await handle(request());expect(r.status).toBe(200);const body=await r.json();expect(body.deviceToken).toBe(token);expect(JSON.stringify(body)).not.toContain(viewer);expect((await handle(request())).status).toBe(403);expect(readFileSync(join(root,"pairing.json"),"utf8")).not.toContain(code);}finally{rmSync(root,{recursive:true,force:true});}});
test("expiry, attempt budget and persistent revocation fail closed",async()=>{const root=fixture();try{const handle=pairingHandler(root,()=>1000);for(let n=0;n<5;n++)expect((await handle(request("ZZZZZZZZZZZZ"))).status).toBe(403);expect((await handle(request())).status).toBe(403);revokeEnrollment(root);expect(privateRead<Enrollment>(join(root,"enrollment.json")).revoked).toBe(true);expect((await pairingHandler(root,()=>1000)(request())).status).toBe(403);}finally{rmSync(root,{recursive:true,force:true});}const root2=fixture();try{expect((await pairingHandler(root2,()=>3000)(request())).status).toBe(403);}finally{rmSync(root2,{recursive:true,force:true});}});
