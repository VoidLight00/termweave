import { expect,it } from 'bun:test';
import { GitHubWatchStore } from './watch-github-store.ts';
import { emptyDurableState } from './watch-store.ts';
const sha='a'.repeat(40);
it('restores contents state and distinguishes missing state from a missing branch',async()=>{
 const responses=[Response.json({object:{sha}}),Response.json({sha,encoding:'base64',content:Buffer.from(JSON.stringify(emptyDurableState())).toString('base64')})];
 const store=new GitHubWatchStore('example/termweave','mock','state',(async()=>responses.shift()!) as any);
 expect((await store.read())?.state).toEqual(emptyDurableState());
 const missing=new GitHubWatchStore('example/termweave','mock','state',(async(url:string)=>url.includes('/git/ref/')?Response.json({object:{sha}}):new Response('',{status:404})) as any);
 expect(await missing.read()).toBeNull();
 const noBranch=new GitHubWatchStore('example/termweave','mock','state',(async()=>new Response('',{status:404})) as any);
 await expect(noBranch.read()).rejects.toThrow('404');
});
it('rate limited and uncertain mutations are not retried',async()=>{
 let calls=0;const store=new GitHubWatchStore('example/termweave','mock','state',(async()=>{calls++;return new Response('',{status:429});}) as any);
 await expect(store.compareAndSet(null,emptyDurableState())).rejects.toThrow('429');expect(calls).toBe(1);
});

it('oversized mutation stream is rejected before full response allocation',async()=>{
 const store=new GitHubWatchStore('example/termweave','mock','state',(async()=>new Response('x'.repeat(1048577))) as any);
 await expect(store.compareAndSet(null,emptyDurableState())).rejects.toThrow('Oversized');
});
