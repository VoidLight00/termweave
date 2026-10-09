import importlib.util,pathlib,tempfile,unittest,json,time
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('sync',pathlib.Path(__file__).with_name('sync.py')); m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

def item(stamp=10,commit='a'*40):return {'source':'cmux','sha':commit,'releases':[],'licenseSha256':'x','observedAt':stamp}
class Tests(unittest.TestCase):
 def test_unsafe_refs(self):
  for ref in ['main','--upload-pack=x','a'*39,'../../secret','a'*40+';id']:
   with self.assertRaises(ValueError):m.pin(ref)
 def test_duplicate(self):
  s={};self.assertTrue(m.observe_state(s,item()));self.assertFalse(m.observe_state(s,item(11)));self.assertEqual(len(s['jobs']),0);m.observe_state(s,item(12,'b'*40));self.assertEqual(len(s['jobs']),1)
 def test_stale_cursor(self):
  s={};m.observe_state(s,item())
  with self.assertRaises(ValueError):m.observe_state(s,item(9))
 def test_license_change(self):
  s={};m.observe_state(s,item());i=item(11,'b'*40);i['licenseSha256']='y';m.observe_state(s,i);self.assertEqual(list(s['jobs'].values())[-1]['status'],'blocked')
 def test_failure_backoff(self):
  j={'attempts':2};m.fail(j);self.assertFalse(m.eligible(j,time.time()));self.assertTrue(m.eligible(j,time.time()+2000));j['attempts']=3;self.assertFalse(m.eligible(j,time.time()+90000))
 def test_redaction_by_omission(self):
  result=m.command(['python3','-c','print("Authorization: Bearer PRIVATE cookie=SECRET")'],'.');self.assertNotIn('PRIVATE',json.dumps(result));self.assertNotIn('SECRET',json.dumps(result))
 def test_gate_failure_no_bump(self):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d);(p/'gates').mkdir();(p/'gates/verify_termweave.sh').write_text('exit 1');(p/'package.json').write_text('{"version":"1.0.0"}')
   ok,e=m.gate_all(p);self.assertFalse(ok);self.assertEqual(json.loads((p/'package.json').read_text())['version'],'1.0.0')
 def test_missing_privacy_gate(self):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d);(p/'gates').mkdir();(p/'gates/verify_termweave.sh').write_text('exit 0');ok,e=m.gate_all(p);self.assertFalse(ok);self.assertEqual(e[-1]['exit'],127)
 def test_protected_changes(self):
  for p in ['gates/x.sh','server/auth.ts','package.json','.github/workflows/a.yml','AGENTS.md']:
   with self.assertRaises(ValueError):m.validate_changes([p])
 def test_dirty_baseline_never_clones(self):
  with tempfile.TemporaryDirectory() as d, patch.object(m,'git',return_value=' M app.ts'), patch.object(m,'command') as command:
   job={'attempts':0};m.implement(pathlib.Path(d),pathlib.Path(d),job);self.assertEqual(job['status'],'baseline-dirty');command.assert_not_called()
 def test_retry_observation_preserves_failure(self):
  s={};m.observe_state(s,item());m.observe_state(s,item(11,'b'*40));j=list(s['jobs'].values())[0];j['attempts']=2;m.fail(j);m.observe_state(s,item(12,'b'*40));self.assertEqual(j['attempts'],2);self.assertEqual(j['status'],'failed')
 def test_atomic_state(self):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d)/'state.json';m.atomic(p,{'schema':1});self.assertEqual(m.read(p,{}),{'schema':1});self.assertEqual(p.stat().st_mode&0o777,0o600)

class RevisionTests(unittest.TestCase):
 def test_same_sha_release_change_has_distinct_job(self):
  s={};m.observe_state(s,item());i=item(11);i['releases']=[{'id':1,'tag':'v1'}];m.observe_state(s,i)
  j=item(12);j['releases']=[{'id':1,'tag':'v1'},{'id':2,'tag':'v2'}];m.observe_state(s,j)
  self.assertEqual(len(s['jobs']),2);m.observe_state(s,{**j,'observedAt':13});self.assertEqual(len(s['jobs']),2)
 def test_privacy_missing_stops_before_clone_or_agent(self):
  with tempfile.TemporaryDirectory() as d, patch.object(m,'git',return_value=''),patch.object(m,'command') as command:
   job={'attempts':1};m.implement(pathlib.Path(d),pathlib.Path(d),job);self.assertEqual(job['status'],'privacy-blocked');command.assert_not_called()
 def test_privacy_failure_nonretryable(self):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d);(p/'gates').mkdir();(p/'gates/public_privacy_gate.sh').write_text('exit 7');job={};self.assertFalse(m.privacy_preflight(p,job));self.assertEqual(job['privacyPreflight']['exit'],7);self.assertFalse(m.eligible(job,1))
 def test_runner_and_test_infrastructure_protected(self):
  for p in ['scripts/verify-isolated.ts','scripts/ci-tests.ts','scripts/ui-literals.test.ts','src/a.test.ts','playwright.config.ts','tests/fixture.ts']:
   with self.assertRaises(ValueError):m.validate_changes([p])
  m.validate_changes(['src/app.ts','tools/upstream-adaptation-tests/new.test.ts'],['tools/upstream-adaptation-tests/new.test.ts'])
 def test_bounded_pinned_source(self):
  import base64
  obj={'type':'file','encoding':'base64','size':3,'content':base64.b64encode(b'abc').decode()}
  with patch.object(m,'api',return_value=obj):
   result=m.pinned_file('owner/repo','src/a.ts','a'*40,'license');self.assertEqual(result['sha256'],m.sha(b'abc'));self.assertEqual(result['commit'],'a'*40)
  with patch.object(m,'api',return_value={**obj,'size':40001}):
   with self.assertRaises(m.EvidenceBlocked):m.pinned_file('owner/repo','src/a.ts','a'*40,'license')
 def test_cmux_source_not_prefetched(self):
  import base64
  calls=[];license_content=base64.b64encode(b'license').decode()
  def api(path):
   calls.append(path)
   if '/license?' in path:return {'content':license_content}
   if '/compare/' in path:return {'status':'ahead','total_commits':1,'files':[{'filename':'Sources/Secret.swift','status':'modified'}]}
   raise AssertionError(path)
  job={'sha':'a'*40,'base':'b'*40,'provenance':{'repository':'manaflow-ai/cmux','licenseSha256':m.sha(b'license'),'policy':'reference-only','releases':[]}}
  with patch.object(m,'api',side_effect=api),patch.object(m,'pinned_file',return_value={'content':'README'}) as fetch:
   with self.assertRaises(m.EvidenceBlocked):m.evidence_packet(job)
   self.assertEqual(fetch.call_count,1);self.assertEqual(fetch.call_args.args[1],'README.md')
 def test_service_path_contains_all_verified_tools(self):
  spec=importlib.util.spec_from_file_location('service',pathlib.Path(__file__).with_name('service.py'));svc=importlib.util.module_from_spec(spec);spec.loader.exec_module(svc)
  with patch.object(svc.shutil,'which',side_effect=lambda t:'/tool-'+t+'/'+t),patch.object(svc.os,'access',return_value=True),patch.object(svc.subprocess,'run') as run:
   run.return_value.returncode=0;path=svc.verified_path()
   for tool in ('bun','node','herdr','tmux','git','codex'):self.assertIn('/tool-'+tool,path)
   self.assertEqual(run.call_count,6)

class PrefetchTests(unittest.TestCase):
 def test_permitted_source_packet_has_provenance(self):
  import base64
  license_bytes=b'MIT';blob=base64.b64encode(license_bytes).decode()
  def api(path):
   if '/license?' in path:return {'content':blob,'license':{'spdx_id':'MIT'}}
   if '/compare/' in path:return {'status':'ahead','total_commits':1,'files':[{'filename':'src/new.ts','status':'added'}]}
   if '/contents/' in path:return {'type':'file','encoding':'base64','size':3,'content':base64.b64encode(b'abc').decode()}
   raise AssertionError(path)
  job={'sha':'a'*40,'base':'b'*40,'provenance':{'repository':'devswha/herdr-web-ui','licenseSha256':m.sha(license_bytes),'policy':'MIT','releases':[]}}
  with patch.object(m,'api',side_effect=api):
   packet=m.evidence_packet(job);self.assertTrue(packet['untrusted']);self.assertEqual(len(packet['documents']),2)
   for d in packet['documents']:self.assertEqual(d['commit'],'a'*40);self.assertEqual(d['licenseSha256'],m.sha(license_bytes))
 def test_release_edit_after_observation_is_blocked(self):
  import base64
  def api(path):
   if '/license?' in path:return {'content':base64.b64encode(b'MIT').decode(),'license':{'spdx_id':'MIT'}}
   if '/compare/' in path:return {'status':'identical','files':[]}
   if '/releases/' in path:return {'body':'changed','tag_name':'v1'}
   raise AssertionError(path)
  job={'sha':'a'*40,'base':'a'*40,'provenance':{'repository':'devswha/herdr-web-ui','licenseSha256':m.sha(b'MIT'),'policy':'MIT','releases':[{'id':1,'bodySha256':m.sha(b'original')}]}}
  with patch.object(m,'api',side_effect=api):
   with self.assertRaises(m.EvidenceBlocked):m.evidence_packet(job)


class RunnerProtectionTests(unittest.TestCase):
 def test_privacy_implementation_and_approval_files_are_protected(self):
  for path in ['tools/public-release/privacy.py','docs/asset-approval-manifest.json','config/privacy-exceptions.json','docs/brand-assets.md']:
   with self.assertRaises(ValueError):m.validate_changes([path])
 def test_symlink_escape_is_rejected(self):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);(root/'escape').symlink_to('/tmp')
   with patch.object(m,'git',return_value='escape/file.ts'):
    with self.assertRaises(ValueError):m.regular_tree(root)
 def test_implemented_without_adaptation_tests_is_rejected(self):
  with tempfile.TemporaryDirectory() as d:
   with self.assertRaises(ValueError):m.adaptation_tests(pathlib.Path(d))
 def test_trusted_runner_does_not_execute_report_commands(self):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);folder=root/'tools/upstream-adaptation-tests';folder.mkdir(parents=True);(folder/'safe.test.ts').write_text('test')
   with patch.object(m,'regular_tree'),patch.object(m.shutil,'which',return_value='/bun'),patch.object(m,'command',return_value={'exit':0}) as run,patch.object(m.sys,'platform','darwin'):
    m.adaptation_tests(root);args=run.call_args.args[0];self.assertIn('--no-env-file',args);self.assertIn(str(folder/'safe.test.ts'),args);self.assertEqual(run.call_args.kwargs['env']['HERDR_TEST_MODE'],'unit')

class ActualBunRunnerTests(unittest.TestCase):
 @unittest.skipUnless(m.sys.platform=='darwin' and m.shutil.which('bun'),'requires macOS and Bun')
 def test_real_positive_and_negative_traps(self):
  for expected in (4,5):
   with tempfile.TemporaryDirectory() as d:
    root=pathlib.Path(d);m.subprocess.run(['git','init','-q',str(root)],check=True);folder=root/'tools/upstream-adaptation-tests';folder.mkdir(parents=True)
    (folder/'trap.test.ts').write_text(f'import {{test,expect}} from "bun:test"; test("trap",()=>expect(2+2).toBe({expected}));\n')
    if expected==4:self.assertEqual(m.adaptation_tests(root)['exit'],0)
    else:
     with self.assertRaises(ValueError):m.adaptation_tests(root)

if __name__=="__main__":unittest.main()
