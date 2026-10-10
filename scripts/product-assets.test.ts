import {expect,it} from 'bun:test';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {showPaneStatusNotification} from '../src/lib/notifications.ts';
const root=join(import.meta.dir,'..');
it('login/main/notification/PWA references use existing independent icon',()=>{
 for(const name of ['src/App.tsx','src/components/AccessGate.tsx','src/lib/notifications.ts','public/sw.js','public/manifest.webmanifest','index.html']){
  const source=readFileSync(join(root,name),'utf8');expect(source).not.toMatch(/icon-192\.png|badge-96\.png|favicon\.png|apple-touch-icon\.png/);
  for(const match of source.matchAll(/(?:"|')((?:\/)?icons\/[^"'?]+)(?:"|')/g))expect(existsSync(join(root,'public',match[1]!.replace(/^\//,'')))).toBe(true);
 }
});
it('notification payload names the TermWeave PNG icon (SVG notification icons do not render on every platform)',async()=>{
 const oldNotification=Object.getOwnPropertyDescriptor(globalThis,'Notification');const oldNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');const payloads:NotificationOptions[]=[];
 class SyntheticNotification{static permission='granted';constructor(_title:string,options:NotificationOptions){payloads.push(options);}addEventListener(){}}
 try{Object.defineProperty(globalThis,'Notification',{configurable:true,value:SyntheticNotification});Object.defineProperty(globalThis,'navigator',{configurable:true,value:{}});showPaneStatusNotification('synthetic-pane','Synthetic title','blocked');await Promise.resolve();expect(payloads).toHaveLength(1);expect(payloads[0]?.icon).toBe('/icons/termweave-v2-192.png');}
 finally{if(oldNotification)Object.defineProperty(globalThis,'Notification',oldNotification);else Reflect.deleteProperty(globalThis,'Notification');if(oldNavigator)Object.defineProperty(globalThis,'navigator',oldNavigator);else Reflect.deleteProperty(globalThis,'navigator');}
});
