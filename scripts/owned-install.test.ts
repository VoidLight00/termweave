import {afterAll,expect,test} from 'bun:test';import {mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {execFileSync} from 'node:child_process';
import {currentUserSid,isOwnedRootDacl,restrictOwnedRoot} from './owned-install.ts';import {trusteeSid} from './windows-sid.ts';
const win=process.platform==='win32';
const base=mkdtempSync(join(tmpdir(),'tw-owned-acl-'));afterAll(()=>rmSync(base,{recursive:true,force:true}));
const icacls=(...args:string[])=>execFileSync(join(process.env.SystemRoot!,'System32','icacls.exe'),args,{stdio:'pipe',windowsHide:true,timeout:15_000});
const other='S-1-5-21-1-2-3-1001';
const readBack=(root:string,name:string)=>{const saved=join(base,name);icacls(root,'/save',saved);return readFileSync(saved).toString('utf16le').split(/\r?\n/)[1]!.trim();};
test.if(win)('win32: SDDL aliases resolve through Windows, machine-relative ones included, and an unknown one resolves to nothing',()=>{
 expect(trusteeSid('SY')).toBe('S-1-5-18');expect(trusteeSid('BA')).toBe('S-1-5-32-544');expect(trusteeSid(other)).toBe(other);
 // LA is this machine's built-in Administrator (RID 500), the account GitHub's windows runner runs the job as
 expect(trusteeSid('LA')).toMatch(/^S-1-5-21-\d+-\d+-\d+-500$/);
 for(const bad of ['QQ','sy','','SYS','S-1-','LA)'])expect([bad,trusteeSid(bad)]).toEqual([bad,undefined]);
});
test.if(!win)('off Windows no alias resolves, so an alias-bearing DACL fails closed',()=>{
 expect(trusteeSid('SY')).toBeUndefined();expect(trusteeSid('LA')).toBeUndefined();expect(trusteeSid('S-1-5-18')).toBe('S-1-5-18');
 expect(isOwnedRootDacl(`D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${other})`,other)).toBe(false);
});
test.if(win)('win32: aliases are compared as their SIDs: LA as the user, SY as SYSTEM; BA, LA for another user and an unknown alias are refused',()=>{
 const la=trusteeSid('LA')!,ok='D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;LA)';
 expect(isOwnedRootDacl(ok,la)).toBe(true);expect(isOwnedRootDacl(`D:PAI(A;OICI;FA;;;S-1-5-18)(A;OICI;FA;;;${la})`,la)).toBe(true);
 for(const bad of [`${ok}(A;OICI;FA;;;BA)`,`D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${other})(A;OICI;FA;;;LA)`,`D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;QQ)`,`D:PAI(A;OICI;FA;;;QQ)(A;OICI;FA;;;LA)`,'D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'])expect([bad,isOwnedRootDacl(bad,la)]).toEqual([bad,false]);
 expect(isOwnedRootDacl(ok,other)).toBe(false);
});
test('a trailing SACL of mandatory-label ACEs is accepted (an elevated creator leaves one); any other SACL ACE or a broken tail is refused',()=>{
 const user='S-1-5-21-1-2-3-500',dacl=`D:PAI(A;OICI;FA;;;S-1-5-18)(A;OICI;FA;;;${user})`;
 expect(isOwnedRootDacl(dacl,user)).toBe(true);expect(isOwnedRootDacl(`${dacl}S:(ML;OICI;NW;;;S-1-16-12288)`,user)).toBe(true);expect(isOwnedRootDacl(`${dacl}S:AI(ML;OICIID;NW;;;S-1-16-12288)`,user)).toBe(true);
 for(const bad of [`${dacl}S:(AU;SA;FA;;;S-1-1-0)`,`${dacl}S:(ML;OICI;NW;;;S-1-16-12288)(AU;SA;FA;;;S-1-1-0)`,`${dacl}S:`,`${dacl}X`])expect([bad,isOwnedRootDacl(bad,user)]).toEqual([bad,false]);
});
test.if(win)('win32: a root owned by the built-in Administrator reads back through icacls as LA and passes the check (the CI runner shape)',()=>{
 const la=trusteeSid('LA')!,root=join(base,'la-root');mkdirSync(root);
 try{
  restrictOwnedRoot(root,la);const sddl=readBack(root,'la-acl');
  expect(sddl).toContain(';;;LA)');expect(sddl).not.toContain(la);expect({sddl,owned:isOwnedRootDacl(sddl,la)}).toEqual({sddl,owned:true});expect(isOwnedRootDacl(sddl,other)).toBe(false);
 }finally{icacls(root,'/reset');}
});
// the elevated runner's shape, reproduced unelevated: explicit ACEs for other trustees on the new root before it is restricted
const seeded=(name:string)=>{const root=join(base,name);mkdirSync(root);icacls(root,'/grant','*S-1-5-32-544:(OI)(CI)F','*S-1-1-0:(R)');const sddl=readBack(root,`${name}-seed`);expect(sddl).toContain('(A;OICI;FA;;;BA)');expect(sddl).toContain(';;;WD)');return root;};
test.if(win)('win32: explicit Administrators and Everyone ACEs survive an icacls edit, and the check refuses the result',()=>{
 const user=currentUserSid(),root=seeded('icacls-edit');
 icacls(root,'/inheritance:r','/grant:r',`*${user}:(OI)(CI)F`,'*S-1-5-18:(OI)(CI)F');const sddl=readBack(root,'icacls-edit-acl');
 expect(sddl.startsWith('D:P')).toBe(true);expect(sddl).toContain('(A;OICI;FA;;;BA)');expect(sddl).toContain(';;;WD)');expect({sddl,owned:isOwnedRootDacl(sddl,user)}).toEqual({sddl,owned:false});
});
test.if(win)('win32: restrictOwnedRoot replaces the whole DACL, so those explicit ACEs are gone and the read-back passes; a missing root fails the apply',()=>{
 const user=currentUserSid(),root=seeded('replaced');
 restrictOwnedRoot(root);const sddl=readBack(root,'replaced-acl');
 expect(sddl).not.toContain(';;;BA)');expect(sddl).not.toContain(';;;WD)');expect(sddl).not.toContain('ID;');expect({sddl,owned:isOwnedRootDacl(sddl,user)}).toEqual({sddl,owned:true});
 expect(()=>restrictOwnedRoot(join(base,'missing'))).toThrow('Owned root ACL apply failed: Win32 error 2');
});
