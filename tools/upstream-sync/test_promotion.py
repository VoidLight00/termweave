import json,pathlib,tempfile,unittest,sys
sys.path.insert(0,str(pathlib.Path(__file__).parent))
import promotion as p

class PromotionTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.top=pathlib.Path(self.tmp.name);self.source=self.top/'source';self.source.mkdir();p.git(self.source,'init','-q');(self.source/'app.txt').write_text('old');p.git(self.source,'add','.');p.git(self.source,'-c','user.name=test','-c','user.email=test@example.invalid','commit','-qm','initial');self.root=self.top/'state';self.repo=p.init_baseline(self.source,self.root);self.base=p.git(self.repo,'rev-parse','HEAD');self.work=self.top/'candidate';p.git(self.source,'clone','--no-local',str(self.repo),str(self.work));p.git(self.work,'remote','remove','origin');(self.work/'app.txt').write_text('new');self.job={'baseCommit':self.base,'source':'herdr','sha':'a'*40,'revision':'r1','provenance':{'licenseSha256':'license'},'compatibility':'implemented','version':'1.0.1'}
 def gate(self,repo):return True,[{'exit':0}]
 def integrate(self):p.integrate(self.repo,self.root,self.work,self.job,self.gate,{})
 def test_success_ff_and_rollback(self):
  self.integrate();self.assertEqual(self.job['status'],'integrated-local');self.assertEqual(p.git(self.repo,'rev-parse',self.job['rollbackRef']),self.base);self.assertEqual((self.repo/'app.txt').read_text(),'new');self.assertEqual(p.git(self.repo,'remote'),'')
 def test_dirty_baseline(self):
  (self.repo/'app.txt').write_text('user')
  with self.assertRaises(ValueError):self.integrate()
  self.assertEqual(p.git(self.repo,'rev-parse','HEAD'),self.base)
 def test_branch_drift(self):
  p.git(self.repo,'checkout','-b','other')
  with self.assertRaises(ValueError):self.integrate()
 def test_head_drift(self):
  p.git(self.repo,'-c','user.name=test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','drift')
  with self.assertRaises(ValueError):self.integrate()
 def test_gate_failure(self):
  self.gate=lambda repo:(False,[{'exit':1}])
  with self.assertRaises(ValueError):self.integrate()
  self.assertEqual(p.git(self.repo,'rev-parse','HEAD'),self.base)
 def test_noop_without_version_bump(self):
  p.git(self.work,'restore','app.txt');self.job.pop('version');self.job['compatibility']='not-applicable';self.integrate();entries=json.loads((self.repo/'docs/upstream-integrations.json').read_text());self.assertIsNone(entries[-1]['version']);self.assertEqual((self.repo/'app.txt').read_text(),'old')
 def test_duplicate_version(self):
  d=self.work/'docs';d.mkdir();(d/'upstream-integrations.json').write_text(json.dumps([{'revision':'other','version':'1.0.1'}]))
  with self.assertRaises(ValueError):self.integrate()
 def test_duplicate_revision(self):
  d=self.work/'docs';d.mkdir();(d/'upstream-integrations.json').write_text(json.dumps([{'revision':'herdr-'+'a'*40+'-r1','version':'1.0.0'}]))
  with self.assertRaises(ValueError):self.integrate()
 def test_protected_change(self):
  before=p.signature(self.work,['app.txt']);(self.work/'app.txt').write_text('tamper')
  with self.assertRaises(ValueError):p.integrate(self.repo,self.root,self.work,self.job,self.gate,before)
 def test_dev_checkout_rejected(self):
  with self.assertRaises(ValueError):p.dedicated(self.source,self.root)
