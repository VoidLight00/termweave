#!/usr/bin/env python3
import sys,json,hashlib
from pathlib import Path
root=Path(sys.argv[1]);folder=Path(__file__).parent
path='daemon/dist/domain/terminal/herdr-adapter.js';p=root/path;s=p.read_text();before=hashlib.sha256(p.read_bytes()).hexdigest()
if before!='0064bb4a39ec0046ba7e595259493862d4237c2a468763836cb434d8fcd6750a':raise SystemExit('Pinned upstream adapter changed')
if 'bindTerminalIdentities' in s:raise SystemExit('Candidate already extended')
s='import { bindTerminalIdentities } from "./termweave-terminal-identities.js";\n'+s
s=s.replace('        const appliedTabIds = [];','        const terminalIdentities = [];\n        const appliedTabIds = [];',1)
anchor='                const tabId = extractTabId(applied);'
s=s.replace(anchor,anchor+'''
                try {
                    const listed = await this.transport.request("pane.list", {workspace_id: workspaceId});
                    terminalIdentities.push(...bindTerminalIdentities(pagePlan.root, applied, listed, pagePanes, launchToken));
                } catch { /* Missing native evidence means no identity mapping. */ }
''',1)
s=s.replace('            pages: plan.pages.length,','            pages: plan.pages.length,\n            terminalIdentities,',1)
p.write_text(s);extra=root/'daemon/dist/domain/terminal/termweave-terminal-identities.js';extra.write_bytes((folder/'terminal-identities.js').read_bytes())
manifest={'version':'0.6.7','patch':'termweave-native-identities-v1','files':{path:{'input':before,'output':hashlib.sha256(p.read_bytes()).hexdigest()},str(extra.relative_to(root)):{'input':None,'output':hashlib.sha256(extra.read_bytes()).hexdigest()}}}
(root/'termweave-terminal-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');(folder/'terminal-output-hashes.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps(manifest))
