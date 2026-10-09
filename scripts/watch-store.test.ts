import { expect,it } from 'bun:test';
import { emptyDurableState,publishCandidates,type DurableState,type WatchStore } from './watch-store.ts';
import { candidateKey,type Candidate } from './watch-upstreams.ts';
const candidate:Candidate={repository:'devswha/herdr-web-ui',kind:'tag',targetSHA:'a'.repeat(40),label:'v1',key:candidateKey('devswha/herdr-web-ui','tag','a'.repeat(40))};
class Store implements WatchStore {
 state:DurableState|null=null;version=0;issues=new Set<string>();writes=0;uncertain=false;
 async read(){return this.state?{state:structuredClone(this.state),version:String(this.version)}:null;}
 async compareAndSet(version:string|null,state:DurableState){if(version !== (this.state?String(this.version):null))throw new Error('CAS conflict');this.state=structuredClone(state);return String(++this.version);}
 async issueExists(key:string){return this.issues.has(key);}
 async createIssue(value:Candidate){this.writes++;this.issues.add(value.key);if(this.uncertain)throw new Error('lost response');}
}
it('restores durable state, handles missing state and deduplicates closed candidates',async()=>{
 const store=new Store();store.issues.add(candidate.key);
 const first=await publishCandidates(store,emptyDurableState().observation,[candidate],'a');expect(first.restored).toBe(false);expect(store.writes).toBe(0);expect(first.state.completed).toEqual([candidate.key]);
 const second=await publishCandidates(store,first.state.observation,[candidate],'b');expect(second.restored).toBe(true);expect(store.writes).toBe(0);
});
it('uncertain writes preserve pending and recover by searching before another POST',async()=>{
 const store=new Store();store.uncertain=true;
 const first=await publishCandidates(store,emptyDurableState().observation,[candidate],'a');expect(first.errors).toHaveLength(1);expect(first.state.pending).toHaveLength(1);expect(first.state.completed).toHaveLength(0);
 store.uncertain=false;const second=await publishCandidates(store,first.state.observation,[],'b');expect(second.errors).toHaveLength(0);expect(store.writes).toBe(1);expect(second.state.pending).toHaveLength(0);
});
it('concurrent writers cannot overwrite leased state',async()=>{
 const store=new Store();store.state={...emptyDurableState(),lease:{owner:'a',until:Date.now()+600000}};store.version=1;
 await expect(publishCandidates(store,store.state.observation,[candidate],'b')).rejects.toThrow('lease');expect(store.writes).toBe(0);
});
it('CAS conflicts fail before writing candidates',async()=>{
 const store=new Store();store.compareAndSet=async()=>{throw new Error('CAS conflict');};
 await expect(publishCandidates(store,emptyDurableState().observation,[candidate],'a')).rejects.toThrow('CAS');expect(store.writes).toBe(0);
});

it('expired or displaced writer cannot POST',async()=>{
 const store=new Store();
 const result=await publishCandidates(store,emptyDurableState().observation,[candidate],'a',Date.now()-700000);
 expect(result.errors[0]).toContain('expired');expect(store.writes).toBe(0);
});
it('uncertain POST with delayed issue visibility is quarantined and never blindly retried',async()=>{
 const store=new Store();store.uncertain=true;await publishCandidates(store,emptyDurableState().observation,[candidate],'a');
 store.issues.clear();store.uncertain=false;
 const second=await publishCandidates(store,emptyDurableState().observation,[],'b');expect(second.errors[0]).toContain('reconciliation');expect(store.writes).toBe(1);
});

it('takeover during awaited uncertain CAS prevents POST and stale final mutation',async()=>{
 const store=new Store();const set=store.compareAndSet.bind(store);let calls=0;
 store.compareAndSet=async(version,state)=>{const next=await set(version,state);calls++;if(calls===2){store.state!.lease={owner:'takeover',until:Date.now()+600000};store.version++;}return next;};
 const result=await publishCandidates(store,emptyDurableState().observation,[candidate],'a');expect(result.errors[0]).toContain('after CAS');expect(store.writes).toBe(0);expect(store.state!.lease!.owner).toBe('takeover');
});
it('lease expiry during awaited uncertain CAS prevents POST',async()=>{
 const store=new Store();const set=store.compareAndSet.bind(store);let calls=0;
 store.compareAndSet=async(version,state)=>{const next=await set(version,state);if(++calls===2)store.state!.lease!.until=Date.now()-1;return next;};
 const result=await publishCandidates(store,emptyDurableState().observation,[candidate],'a');expect(result.errors[0]).toContain('after CAS');expect(store.writes).toBe(0);
});
