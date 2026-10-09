#!/usr/bin/env python3
"""Operate one approved temporary tunnel to the mobile relay, never the app admin."""
import argparse,fcntl,json,os,pathlib,re,shlex,shutil,signal,subprocess,time
ROOT=pathlib.Path.home()/'.local/state/termweave-mobile-relay';ROOT.mkdir(mode=0o700,parents=True,exist_ok=True)
def ps(pid,field):return subprocess.run(['ps','-p',str(pid),'-o',field+'='],capture_output=True).stdout.decode('utf8','replace').strip()
def save(value):
 p=ROOT/'tunnel.json';fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
 with os.fdopen(fd,'w') as f:json.dump(value,f)
def owned():
 p=ROOT/'tunnel.json'
 if not p.exists():return None
 if p.is_symlink() or p.stat().st_mode&0o077:raise RuntimeError('Unsafe process metadata')
 v=json.loads(p.read_text());pid=v['pid']
 return v if ps(pid,'lstart')==v['started'] and shlex.split(ps(pid,'command'))==v['command'] else None
parser=argparse.ArgumentParser();parser.add_argument('action',choices=['start','status','stop']);args=parser.parse_args()
with (ROOT/'tunnel.lock').open('a') as lock:
 os.chmod(lock.name,0o600);fcntl.flock(lock,fcntl.LOCK_EX)
 state=owned()
 if args.action=='stop':
  if state:
   os.kill(state['pid'],signal.SIGTERM)
   for _ in range(40):
    if not owned():break
    time.sleep(.1)
   if owned():raise RuntimeError('Owned tunnel still stopping')
  print(json.dumps({'stopped':bool(state)}))
 elif args.action=='status':print(json.dumps({'running':bool(state),'origin':state.get('origin') if state else None}))
 else:
  if not state:
   binary=shutil.which('cloudflared')
   if not binary:raise RuntimeError('cloudflared is not installed')
   command=[binary,'tunnel','--config',os.devnull,'--no-autoupdate','--url','http://127.0.0.1:7339']
   log=ROOT/'tunnel.log'
   if log.is_symlink():raise RuntimeError('Unsafe tunnel log')
   fd=os.open(log,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
   try:child=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=fd,stderr=fd,start_new_session=True)
   finally:os.close(fd)
   state={'pid':child.pid,'started':ps(child.pid,'lstart'),'command':command,'origin':None};save(state)
   for _ in range(120):
    if child.poll() is not None:raise RuntimeError('Tunnel exited; inspect private log')
    text=log.read_text(errors='replace');m=re.search(r'https://[a-z0-9-]+\.trycloudflare\.com',text)
    if m:state['origin']=m.group();save(state);break
    time.sleep(.25)
   if not state['origin']:raise RuntimeError('Tunnel origin not ready; process retained for diagnosis')
  print(json.dumps({'running':True,'origin':state['origin'],'target':'http://127.0.0.1:7339','pid':state['pid']}))
