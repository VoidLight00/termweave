"""Local-only release integration into an explicit disposable automation baseline."""
import hashlib,json,pathlib,re,subprocess

def git(repo,*args):
    r=subprocess.run(['git','-C',str(repo),*args],capture_output=True)
    if r.returncode: raise RuntimeError('git operation failed')
    return r.stdout.decode('utf-8','replace').strip()

def init_baseline(source,root):
    source=source.resolve();root=root.resolve();target=root/'baseline'
    if git(source,'status','--porcelain'):raise ValueError('source is dirty')
    if target.exists():raise ValueError('baseline already exists')
    root.mkdir(parents=True,exist_ok=True,mode=0o700)
    git(source,'clone','--no-local','--no-hardlinks',str(source),str(target))
    git(target,'remote','remove','origin');git(target,'checkout','-B','automation/baseline')
    marker={'schema':1,'path':str(target),'root':str(root),'initialCommit':git(target,'rev-parse','HEAD')}
    (target/'.git/termweave-automation.json').write_text(json.dumps(marker))
    return target

def dedicated(repo,root):
    repo=repo.resolve();root=root.resolve()
    if repo!=root/'baseline' or not (repo/'.git').is_dir() or (repo/'.git').is_symlink():raise ValueError('not dedicated baseline')
    marker=json.loads((repo/'.git/termweave-automation.json').read_text())
    if marker.get('path')!=str(repo) or marker.get('root')!=str(root):raise ValueError('baseline marker mismatch')
    if git(repo,'remote') or git(repo,'branch','--show-current')!='automation/baseline':raise ValueError('baseline remote or branch changed')

def signature(repo,paths):
    result={}
    for p in paths:
        file=repo/p
        if file.is_symlink():result[p]='symlink:'+str(file.readlink())
        elif file.is_file():result[p]=hashlib.sha256(file.read_bytes()).hexdigest()
        else:result[p]='missing'
    return result

def protected_snapshot(repo,validator):
    paths=[]
    for p in git(repo,'ls-files').splitlines():
        try:validator([p])
        except ValueError:paths.append(p)
    return signature(repo,paths)

def check_protected(repo,before):
    if signature(repo,before)!=before:raise ValueError('protected files changed')

def integrate(repo,root,work,job,gate,protected):
    dedicated(repo,root)
    base=job['baseCommit']
    if git(repo,'status','--porcelain') or git(repo,'rev-parse','HEAD')!=base:raise ValueError('baseline drift')
    if git(work,'rev-parse','HEAD')!=base:raise ValueError('candidate history drift')
    check_protected(work,protected)
    ledger=work/'docs/upstream-integrations.json'
    entries=json.loads(ledger.read_text()) if ledger.exists() else []
    revision=job['source']+'-'+job['sha']+'-'+job.get('revision','legacy')
    if any(e['revision']==revision for e in entries):raise ValueError('duplicate candidate revision')
    version=job.get('version')
    if version and any(e.get('version')==version for e in entries):raise ValueError('duplicate candidate version')
    entries.append({'revision':revision,'source':job['source'],'upstreamCommit':job['sha'],'licenseSha256':job['provenance']['licenseSha256'],'version':version,'classification':job['compatibility']})
    ledger.parent.mkdir(parents=True,exist_ok=True);ledger.write_text(json.dumps(entries,indent=2)+'\n')
    changelog=work/'docs/upstream-CHANGELOG.md'
    with changelog.open('a') as f:f.write(f"\n## {version or 'No behavior change'}\n\n{job['source']} {job['sha']} ({job['compatibility']}).\n")
    ok,evidence=gate(work);job['integrationGates']=evidence
    if not ok:raise ValueError('integration gate failed')
    check_protected(work,protected)
    # Gate success is bound to the exact tree that gets committed.
    git(work,'add','--all')
    tree=git(work,'write-tree')
    git(work,'-c','user.name=TermWeave Update Agent','-c','user.email=termweave-bot@users.noreply.github.com','commit','-m','chore: integrate verified upstream '+job['source'])
    commit=git(work,'rev-parse','HEAD')
    if git(work,'rev-parse','HEAD^{tree}')!=tree or git(work,'status','--porcelain'):raise ValueError('candidate changed during commit')
    dedicated(repo,root)
    if git(repo,'status','--porcelain') or git(repo,'rev-parse','HEAD')!=base:raise ValueError('baseline drift before integration')
    rollback='refs/termweave/rollback/'+hashlib.sha256(revision.encode()).hexdigest()[:24]
    git(repo,'update-ref',rollback,base)
    git(repo,'fetch',str(work),commit)
    # --ff-only rejects concurrent non-ancestor changes. Never force, reset, or merge divergent code.
    if git(repo,'rev-parse','HEAD')!=base:raise ValueError('baseline drift after fetch')
    git(repo,'merge','--ff-only',commit)
    if git(repo,'rev-parse','HEAD')!=commit or git(repo,'status','--porcelain'):raise ValueError('integration verification failed')
    job.update(status='integrated-local',integratedCommit=commit,rollbackRef=rollback)
