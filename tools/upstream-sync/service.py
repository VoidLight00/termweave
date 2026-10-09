#!/usr/bin/env python3
"""Explicit launchd installer. Creating this file does not enable a service."""
import argparse,json,os,pathlib,plistlib,shutil,subprocess,sys
LABEL='com.termweave.upstream-sync'
def verified_path():
    directories=[]
    for tool in ('bun','node','herdr','tmux','git','codex'):
        executable=shutil.which(tool)
        if not executable or not os.access(executable,os.X_OK): raise RuntimeError('missing executable: '+tool)
        result=subprocess.run([executable,'-V' if tool=='tmux' else '--version'],capture_output=True,timeout=15)
        if result.returncode: raise RuntimeError('executable version probe failed: '+tool)
        directories.append(str(pathlib.Path(executable).parent))
    return os.pathsep.join(dict.fromkeys(directories+['/usr/bin','/bin','/usr/sbin','/sbin']))

def main():
    p=argparse.ArgumentParser();p.add_argument('action',choices=['install','status','disable']);p.add_argument('--repo',type=pathlib.Path);p.add_argument('--state',type=pathlib.Path);p.add_argument('--implement',action='store_true');p.add_argument('--promote-local',action='store_true');a=p.parse_args()
    path=pathlib.Path.home()/'Library/LaunchAgents'/f'{LABEL}.plist'; domain=f'gui/{os.getuid()}'
    if a.action=='install':
        if not a.repo or not a.state: p.error('--repo and --state required')
        repo=a.repo.resolve(); state=a.state.resolve(); script=repo/'tools/upstream-sync/sync.py'
        if not script.is_file(): p.error('sync.py missing')
        state.mkdir(parents=True,exist_ok=True,mode=0o700);state.chmod(0o700)
        argv=[sys.executable,str(script),'--repo',str(repo),'--state',str(state)]
        if a.implement: argv+=['--implement']
        if a.promote_local:
            if not a.implement:p.error('--promote-local requires --implement')
            from promotion import dedicated
            dedicated(repo,state)
            argv+=['--promote-local']
        obj={'Label':LABEL,'ProgramArguments':argv,'StartInterval':3600,'RunAtLoad':True,'WorkingDirectory':str(repo),'ProcessType':'Background','StandardOutPath':str(state/'service.log'),'StandardErrorPath':str(state/'service-error.log'),'EnvironmentVariables':{'PATH':verified_path()}}
        path.parent.mkdir(parents=True,exist_ok=True)
        if path.exists(): p.error('service exists; disable before replacement')
        path.write_bytes(plistlib.dumps(obj));path.chmod(0o600)
        result=subprocess.run(['launchctl','bootstrap',domain,str(path)])
        if result.returncode: path.unlink();raise SystemExit(result.returncode)
        print('installed; hourly; implementation='+str(a.implement))
    elif a.action=='disable':
        subprocess.run(['launchctl','bootout',domain+'/'+LABEL],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        if path.exists():path.unlink()
        print('disabled; candidates and evidence retained')
    else:
        r=subprocess.run(['launchctl','print',domain+'/'+LABEL],capture_output=True)
        print(json.dumps({'installed':path.exists(),'registered':r.returncode==0}))

if __name__=='__main__': main()
