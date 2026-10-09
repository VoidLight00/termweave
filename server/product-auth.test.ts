import {expect,it} from 'bun:test';import {isAuthenticated,deviceCookie,isSecureRequest,handleAuthRequest} from './auth.ts';import {decideAccess} from './access.ts';
it('upstream cookies do not authenticate TermWeave and logout preserves upstream namespace',async()=>{
 const token='synthetic-token';expect(isAuthenticated(new Request('http://localhost',{headers:{cookie:`herdr_web_token=${token}`}}),token)).toBe(false);expect(isAuthenticated(new Request('http://localhost',{headers:{cookie:`termweave_token=${token}; herdr_web_token=upstream`}}),token)).toBe(true);
 const logout=await handleAuthRequest(new Request('http://localhost/api/auth',{method:'DELETE'}),token);expect(logout.headers.get('set-cookie')).not.toContain('herdr_web_');expect(logout.headers.get('set-cookie')).toContain('termweave_device=');
});
it('HTTPS proxy cookies are hardened and invalid credentials cannot expose external terminals',()=>{
 const request=new Request('http://localhost',{headers:{'x-forwarded-proto':'https'}});expect(isSecureRequest(request)).toBe(true);expect(deviceCookie('synthetic',true)).toContain('HttpOnly; SameSite=Strict');expect(deviceCookie('synthetic',true)).toContain('; Secure');
 const access=decideAccess({loopback:false,forwarded:false,funnel:false,tailscaleLogin:null,tokenMatched:false,device:null,owner:null,tagged:false,tokenConfigured:false,gated:false});expect(access.level).toBe('none');
});
