import contextlib
import io
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('openrig_daemon', Path(__file__).with_name('openrig-daemon.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class OwnershipTests(unittest.TestCase):
    def test_reused_pid_and_wrong_listener_are_not_owned(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root/'data').mkdir(); package = root/'package'
            state = root/'data/daemon.json'
            state.write_text(json.dumps({'pid':12345,'host':'127.0.0.1','port':7338}))
            with patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([],0,b'501 /usr/bin/other-process\n',b'')):
                self.assertEqual(module.ownership(root,package),'unknown')
            state.write_text(json.dumps({'pid':12345,'host':'0.0.0.0','port':7338}))
            with patch.object(module.subprocess, 'run') as run:
                self.assertEqual(module.ownership(root,package),'unknown');run.assert_not_called()
    def test_exact_same_user_daemon_only(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root/'data').mkdir(); package = root/'package'
            (root/'data/daemon.json').write_text(json.dumps({'pid':12345,'host':'127.0.0.1','port':7338}))
            output = f'{module.os.getuid()} /usr/bin/node {package}/daemon/dist/index.js\n'.encode()
            with patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([],0,output,b'')):
                self.assertEqual(module.ownership(root,package),'owned')
            with patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([],1,b'',b'')):
                self.assertEqual(module.ownership(root,package),'absent')
    def test_symlinked_pid_record_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'data').mkdir();(root/'outside').write_text('{}');(root/'data/daemon.json').symlink_to(root/'outside')
            self.assertEqual(module.ownership(root,root/'package'),'unknown')


class ProviderEnvironmentTests(unittest.TestCase):
    def test_start_preserves_account_home_and_scopes_provider_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            package = base / '.local/share/termweave-openrig/node_modules/@openrig/cli'
            package.mkdir(parents=True)
            (package / 'package.json').write_text(json.dumps({'name': '@openrig/cli', 'version': module.VERSION}))
            state = base / '.local/state/termweave-openrig'
            inherited = {'HOME': str(base), 'PATH': '/usr/bin', 'CODEX_HOME': '/wrong/codex',
                         'CLAUDE_CONFIG_DIR': '/wrong/claude', 'OPENRIG_HOME': '/wrong/rig',
                         'OPENRIG_PORT': '9999', 'RIGGED_URL': 'foreign', 'HERDR_SOCKET_PATH': '/wrong/socket'}
            output = io.StringIO()
            with patch.object(module.Path, 'home', return_value=base), \
                 patch.dict(module.os.environ, inherited, clear=True), \
                 patch.object(module.shutil, 'which', return_value='/usr/bin/node'), \
                 patch.object(module, 'ownership', side_effect=['absent', 'owned']), \
                 patch.object(module, 'health', side_effect=[None, {'status': 'ok', 'semver': module.VERSION}]), \
                 patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, b'', b'')) as run, \
                 patch('sys.argv', ['openrig-daemon.py', 'start']), contextlib.redirect_stdout(output):
                module.main()
                self.assertEqual(module.os.environ['CODEX_HOME'], '/wrong/codex')
            run.assert_called_once()
            env = run.call_args.kwargs['env']
            self.assertEqual(env['HOME'], str(base))
            for name, folder in [('OPENRIG_HOME', 'data'), ('CODEX_HOME', 'codex'), ('CLAUDE_CONFIG_DIR', 'claude')]:
                self.assertEqual(env[name], str(state / folder))
                self.assertEqual((state / folder).stat().st_mode & 0o777, 0o700)
            self.assertNotIn('OPENRIG_PORT', env)
            self.assertNotIn('RIGGED_URL', env)
            self.assertEqual(env['HERDR_SOCKET_PATH'], str(base / '.config/herdr/herdr.sock'))
            self.assertEqual(run.call_args.args[0][-5:], ['--no-kernel', '--host', '127.0.0.1', '--port', '7338'])
            self.assertTrue(json.loads(output.getvalue())['running'])

if __name__ == '__main__': unittest.main()
