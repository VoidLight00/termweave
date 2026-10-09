export function developmentTarget(value=process.env.TERMWEAVE_DEV_BACKEND):string {
 const url=new URL(value??'http://127.0.0.1:7327');
 if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Development backend must be an explicit loopback HTTP origin');
 return url.origin;
}
