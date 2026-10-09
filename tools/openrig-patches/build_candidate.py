#!/usr/bin/env python3
"""Create an isolated Apache-2.0 OpenRig candidate. Never modify the source installation."""
import argparse, hashlib, json, shutil, os
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--source',required=True);p.add_argument('--output',required=True);a=p.parse_args()
source=Path(a.source).resolve();output=Path(a.output).resolve()
if output.exists() or output==source or source in output.parents:raise SystemExit('Output must be a new directory outside the installation')
pins=json.loads((Path(__file__).parent/'input-hashes.json').read_text())
for path,digest in pins['files'].items():
 if hashlib.sha256((source/path).read_bytes()).hexdigest()!=digest:raise SystemExit('Pinned upstream file changed: '+path)
shutil.copytree(source,output,symlinks=True)
# Reuse installed dependencies; no package install or account access occurs.
(output/'node_modules').symlink_to(source.parent.parent,target_is_directory=True)
repo=output/'daemon/dist/domain/queue-repository.js';text=repo.read_text();start=text.index('    async handoff(input) {');end=text.index('    async handoffAndComplete',start);part=text[start:end]
anchor='        if (isTerminalState(source.state)) {'
guard='''        // TermWeave CAS v1: an explicitly bound operator handoff may only act on its own unchanged row.
        const expected = input.expectedCurrent;
        if (expected !== undefined && (!expected || typeof expected !== "object"
            || typeof expected.tsUpdated !== "string" || typeof expected.state !== "string"
            || typeof expected.destinationSession !== "string"
            || input.fromSession !== expected.destinationSession
            || source.destinationSession !== expected.destinationSession
            || source.state !== expected.state || source.tsUpdated !== expected.tsUpdated)) {
            throw new QueueRepositoryError("qitem_precondition_failed", "Queue item changed or actor does not own it");
        }
'''
if part.count(anchor)!=1:raise SystemExit('Missing guard anchor')
part=part.replace(anchor,guard+anchor,1)
old='''            this.db
                .prepare(`UPDATE queue_items
             SET state = 'handed-off',
                 ts_updated = ?,
                 handed_off_to = ?,
                 closure_reason = 'handed_off_to',
                 closure_target = ?
           WHERE qitem_id = ?`)
                .run(ts, input.toSession, input.toSession, source.qitemId);'''
new='''            const update = this.db
                .prepare(`UPDATE queue_items
             SET state = 'handed-off',
                 ts_updated = ?,
                 handed_off_to = ?,
                 closure_reason = 'handed_off_to',
                 closure_target = ?
           WHERE qitem_id = ?` + (expected ? " AND ts_updated = ? AND state = ? AND destination_session = ?" : ""))
                .run(ts, input.toSession, input.toSession, source.qitemId,
                    ...(expected ? [expected.tsUpdated, expected.state, expected.destinationSession] : []));
            if (expected && update.changes !== 1) {
                throw new QueueRepositoryError("qitem_precondition_failed", "Queue item changed before handoff commit");
            }'''
if part.count(old)!=1:raise SystemExit('Missing CAS anchor')
part=part.replace(old,new,1);repo.write_text(text[:start]+part+text[end:])
route=output/'daemon/dist/routes/queue.js';text=route.read_text();text=text.replace('    // POST /create','    app.get("/termweave-capabilities", (c) => c.json({handoffCompareAndSwap: 1}));\n    // POST /create',1)
text=text.replace('const status = err.code === "qitem_not_found" ? 404','const status = err.code === "qitem_precondition_failed" ? 409 : err.code === "qitem_not_found" ? 404',1)
start=text.index('    app.post("/:qitemId/handoff",');end=text.index('    // POST /:qitemId/handoff-and-complete',start);part=text[start:end];anchor='const result = await getRepo(c).handoff({\n                qitemId,'
if part.count(anchor)!=1:raise SystemExit('Missing route anchor')
part=part.replace(anchor,'const result = await getRepo(c).handoff({\n                expectedCurrent: body.expectedCurrent,\n                qitemId,',1);route.write_text(text[:start]+part+text[end:])
manifest={**pins,'purpose':'human-owned queue handoff atomic compare-and-swap','output_files':{path:hashlib.sha256((output/path).read_bytes()).hexdigest() for path in pins['files']},'source_unchanged':all(hashlib.sha256((source/path).read_bytes()).hexdigest()==digest for path,digest in pins['files'].items())}
(output/'termweave-patch-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'candidate':str(output),'source_unchanged':manifest['source_unchanged']}))
