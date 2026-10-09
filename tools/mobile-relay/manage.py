#!/usr/bin/env python3
"""Manage only the recorded TermWeave relay process. Never emit permanent credentials."""
import argparse,datetime,hashlib,json,os,pathlib,secrets,shutil,signal,subprocess,time,shlex,plistlib,urllib.request,urllib.parse,sys
ROOT=pathlib.Path(__file__).resolve().parent
parser=argparse.ArgumentParser();parser.add_argument('action',choices=['init','start','stop','status','pair','revoke','rotate','prepare-tunnel','configure-viewer','install','uninstall']);parser.add_argument('--state-dir',default=str(pathlib.Path.home()/'.local/state/termweave-mobile-relay'));parser.add_argument('--port',type=int,default=7339);parser.add_argument('--public-origin');parser.add_argument('--app-state-dir');args=parser.parse_args();state=pathlib.Path(args.state_dir).resolve();state.mkdir(parents=True,exist_ok=True,mode=0o700)
def read(name):
 p=state/name;s=p.lstat()
 if p.is_symlink() or s.st_mode&0o077 or s.st_uid!=os.getuid():raise RuntimeError('Unsafe private state permissions')
 return json.loads(p.read_text())
def write(name,data):
 p=state/name;t=state/(name+'.'+secrets.token_hex(8)+'.tmp');fd=os.open(t,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'w') as f:json.dump(data,f)
 os.replace(t,p)
def ps(pid,field):return subprocess.run(['ps','-p',str(pid),'-o',field+'='],capture_output=True).stdout.decode('utf-8','replace').strip()
def owned():
 try:
  p=read('process.json');cmd=ps(p['pid'],'command');born=ps(p['pid'],'lstart')
  return p if born==p['started'] and shlex.split(cmd)[-2:]==[str(ROOT/'daemon.ts'),str(state)] else None
 except (FileNotFoundError,KeyError):return None
def stop():
 p=owned()
 if not p:return False
 os.kill(p['pid'],signal.SIGTERM)
 for _ in range(30):
  if not owned():break
  time.sleep(.1)
 if owned():os.kill(p['pid'],signal.SIGKILL)
 (state/'process.json').unlink(missing_ok=True);return True
def init():
 if (state/'enrollment.json').exists():return
 if not 1024<=args.port<=65535:raise RuntimeError('Invalid port')
 write('enrollment.json',dict(deviceToken=secrets.token_urlsafe(32),viewerToken=secrets.token_urlsafe(32),expiresAt=int((time.time()+86400)*1000),revoked=False,port=args.port,instanceId=secrets.token_hex(16)))
def start():
 init();p=owned()
 if p:return p
 bun=shutil.which('bun')
 if not bun:raise RuntimeError('Bun not installed')
 log=os.open(state/'service.log',os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)
 try:child=subprocess.Popen([bun,str(ROOT/'daemon.ts'),str(state)],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
 finally:os.close(log)
 p={'pid':child.pid,'started':ps(child.pid,'lstart'),'script':str(ROOT/'daemon.ts')};write('process.json',p)
 e=read('enrollment.json')
 for _ in range(40):
  if child.poll() is not None:raise RuntimeError('Relay process exited; check private service.log')
  try:
   with urllib.request.urlopen(f'http://127.0.0.1:{e["port"]}/health',timeout=.25) as r:
    health=json.load(r)
    if health.get('service')=='termweave-mobile-relay' and health.get('instanceId')==e['instanceId']:return p
  except Exception:pass
  time.sleep(.1)
 stop();raise RuntimeError('Relay health did not become ready')
def public_origin():
 u=urllib.parse.urlsplit(args.public_origin or '')
 if u.scheme!='https' or not u.hostname or u.username or u.password or u.path not in ('','/') or u.query or u.fragment:raise RuntimeError('A plain HTTPS origin is required')
 return 'https://'+u.netloc
try:
 result={}
 if args.action=='init':init();result={'initialized':True}
 elif args.action=='start':p=start();result={'running':True,'pid':p['pid'],'port':read('enrollment.json')['port']}
 elif args.action=='stop':result={'stopped':stop()}
 elif args.action=='install':
  init();stop();bun=shutil.which('bun')
  if not bun:raise RuntimeError('Bun not installed')
  target=pathlib.Path.home()/'Library/LaunchAgents/com.termweave.mobile-relay.plist';target.parent.mkdir(parents=True,exist_ok=True)
  content={'Label':'com.termweave.mobile-relay','ProgramArguments':[bun,str(ROOT/'daemon.ts'),str(state)],'RunAtLoad':True,'KeepAlive':{'SuccessfulExit':False},'ThrottleInterval':10,'StandardOutPath':str(state/'service.log'),'StandardErrorPath':str(state/'service.log'),'WorkingDirectory':str(ROOT)}
  target.write_bytes(plistlib.dumps(content));target.chmod(0o600)
  domain='gui/'+str(os.getuid());subprocess.run(['launchctl','bootout',domain+'/com.termweave.mobile-relay'],capture_output=True)
  check=subprocess.run(['launchctl','bootstrap',domain,str(target)],capture_output=True)
  if check.returncode:raise RuntimeError('LaunchAgent bootstrap failed')
  result={'installed':True,'label':'com.termweave.mobile-relay','plist':str(target)}
 elif args.action=='uninstall':
  subprocess.run(['launchctl','bootout','gui/'+str(os.getuid())+'/com.termweave.mobile-relay'],capture_output=True);stop();(pathlib.Path.home()/'Library/LaunchAgents/com.termweave.mobile-relay.plist').unlink(missing_ok=True);result={'uninstalled':True}
 elif args.action=='status':
  p=owned();e=read('enrollment.json') if (state/'enrollment.json').exists() else {};result={'running':bool(p),'pid':p['pid'] if p else None,'port':e.get('port'),'revoked':e.get('revoked'),'expiresAt':e.get('expiresAt'),'stateDir':str(state)}
 elif args.action=='revoke':
  e=read('enrollment.json');e['revoked']=True;write('enrollment.json',e);stopped=stop();result={'revoked':True,'persistent':True,'serviceStopped':stopped}
 elif args.action=='rotate':
  stop();(state/'enrollment.json').unlink(missing_ok=True);(state/'pairing.json').unlink(missing_ok=True);init();start();result={'rotated':True,'running':True}
 elif args.action=='pair':
  e=read('enrollment.json')
  if e['revoked'] or e['expiresAt']<=int(time.time()*1000):raise RuntimeError('Enrollment inactive; rotate explicitly first')
  code=''.join(secrets.choice('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567') for _ in range(12));expiry=int((time.time()+300)*1000);write('pairing.json',{'codeHash':hashlib.sha256(code.encode()).hexdigest(),'expiresAt':expiry,'used':False,'attempts':0});result={'pairingCode':code,'expiresAt':expiry,'singleUse':True}
 elif args.action=='prepare-tunnel':result={'command':['cloudflared','tunnel','--no-autoupdate','--url','http://127.0.0.1:'+str(read('enrollment.json')['port'])],'executed':False,'scope':'Only relay endpoints, never TermWeave admin','warning':'Quick Tunnel is temporary development access, not production hosting'}
 elif args.action=='configure-viewer':
  origin=public_origin();e=read('enrollment.json')
  if not args.app_state_dir:raise RuntimeError('--app-state-dir is required')
  target=pathlib.Path(args.app_state_dir).resolve();target.mkdir(parents=True,exist_ok=True,mode=0o700);temp=target/('.mobile-relay-'+secrets.token_hex(8)+'.tmp');fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
  with os.fdopen(fd,'w') as f:json.dump({'endpoint':origin.replace('https:','wss:')+'/connect?role=viewer','viewerToken':e['viewerToken']},f)
  os.replace(temp,target/'mobile-relay.json');result={'configured':True,'endpoint':origin,'restartOrReloadGatewayRequired':True}
 print(json.dumps(result))
except Exception as exc:
 print(json.dumps({'error':str(exc) if isinstance(exc,RuntimeError) else type(exc).__name__}),file=sys.stderr);sys.exit(1)
