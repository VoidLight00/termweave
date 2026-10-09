import { existsSync } from "node:fs";
import { apkDownloadHandler } from "./apk";
import { join, resolve } from "node:path";
import { startMobileRelay } from "../../server/mobile-relay/serve";
import { privateRead, privateWrite, revokeEnrollment, pairingHandler, type Enrollment } from "./enrollment";
const root=resolve(process.argv[2]??"");if(!process.argv[2])throw new Error("State directory required");
const file=join(root,"enrollment.json"),e=privateRead<Enrollment>(file);
if(!Number.isInteger(e.port)||e.port<1024||e.port>65535)throw new Error("Invalid port");
const apkManifest=join(root,"apk.json");
const download=existsSync(apkManifest)?apkDownloadHandler(apkManifest):undefined;
const relay=startMobileRelay({download,deviceToken:e.deviceToken,viewerToken:e.viewerToken,expiresAt:e.expiresAt,port:e.port,onRevoke:()=>revokeEnrollment(root),pairing:pairingHandler(root),health:()=>({service:"termweave-mobile-relay",active:!privateRead<Enrollment>(file).revoked&&e.expiresAt>Date.now(),instanceId:e.instanceId,expiresAt:e.expiresAt})});
const started=Bun.spawnSync(["ps","-p",String(process.pid),"-o","lstart="]).stdout.toString().trim();
privateWrite(join(root,"process.json"),{pid:process.pid,started,script:resolve(import.meta.dir,"daemon.ts")});
let revoked=false;if(e.revoked||e.expiresAt<=Date.now()){revoked=true;relay.hub.revoke();}const timer=setInterval(()=>{try{if(privateRead<Enrollment>(file).revoked&&!revoked){revoked=true;relay.hub.revoke();}}catch{revoked=true;relay.hub.revoke();}},500);
function stop(){clearInterval(timer);relay.stop();process.exit(0);}
process.on("SIGTERM",stop);process.on("SIGINT",stop);
