import { readFileSync, writeFileSync, renameSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
export interface Enrollment { deviceToken:string; viewerToken:string; expiresAt:number; revoked:boolean; port:number; publicOrigin?:string; instanceId?:string }
interface Pairing { codeHash:string; expiresAt:number; used:boolean; attempts:number }
export function privateRead<T>(path:string):T {const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077)!==0||s.uid!==process.getuid?.())throw new Error("Unsafe state permissions");return JSON.parse(readFileSync(path,"utf8"));}
export function privateWrite(path:string,value:unknown){const temp=path+"."+randomUUID()+".tmp";writeFileSync(temp,JSON.stringify(value),{mode:0o600,flag:"wx"});renameSync(temp,path);}
export function revokeEnrollment(root:string){const path=join(root,"enrollment.json"),e=privateRead<Enrollment>(path);e.revoked=true;privateWrite(path,e);}
export function pairingHandler(root:string,now=Date.now){return async(req:Request):Promise<Response>=>{
 const reply=(value:unknown,status:number)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
 try{
  if(req.headers.get("content-type")?.split(";")[0]!=="application/json")return reply({error:"invalid_request"},400);
  const r=req.body?.getReader();if(!r)return reply({error:"invalid_request"},400);let body="";
  try{for(;;){const n=await r.read();if(n.done)break;body+=new TextDecoder().decode(n.value);if(body.length>1024)return reply({error:"invalid_request"},413);}}finally{await r.cancel();}
  const data=JSON.parse(body);if(!data||typeof data.code!=="string"||!/^[A-Z2-7]{12}$/.test(data.code))return reply({error:"pairing_denied"},403);
  const enrollment=privateRead<Enrollment>(join(root,"enrollment.json")),path=join(root,"pairing.json"),p=privateRead<Pairing>(path);
  if(enrollment.revoked||enrollment.expiresAt<=now()||p.used||p.attempts>=5||p.expiresAt<=now())return reply({error:"pairing_denied"},403);
  const expected=Buffer.from(p.codeHash,"hex"),actual=createHash("sha256").update(data.code).digest();
  p.attempts++;if(expected.length!==32||!timingSafeEqual(expected,actual)){privateWrite(path,p);return reply({error:"pairing_denied"},403);}
  p.used=true;privateWrite(path,p);
  return reply({deviceToken:enrollment.deviceToken,expiresAt:enrollment.expiresAt},200);
 }catch{return reply({error:"pairing_denied"},403);}
};}
