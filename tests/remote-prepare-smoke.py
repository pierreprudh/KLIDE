#!/usr/bin/env python3
"""Run the actual preparation script against unprivileged package-manager fixtures."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/remote-host/prepare-machine.sh'

class PrepareMachine(unittest.TestCase):
    def run_fixture(self, missing='', admin=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            commands = {
                'uname': 'echo Linux',
                'id': 'echo ' + ('0' if admin else '1000'),
                'git': ':', 'curl': ':', 'gh': ':', 'claude': ':',
                'dpkg-query': 'echo installed',
                'sudo': 'echo sudo >> "$FIXTURE_LOG"; exit 1',
                'apt-get': 'echo "apt-get $*" >> "$FIXTURE_LOG"',
            }
            if missing:
                commands['dpkg-query'] = 'case "$*" in *"' + missing + '"*) exit 1;; *) echo installed;; esac'
            for name, body in commands.items():
                file = root / name
                file.write_text('#!/bin/sh\n' + body + '\n')
                file.chmod(0o755)
            log = root / 'calls'
            env = dict(os.environ, PATH=str(root), HOME=str(root), FIXTURE_LOG=str(log))
            result = subprocess.run(['/bin/sh', str(SCRIPT)], env=env, capture_output=True, text=True)
            return result, log.read_text() if log.exists() else ''

    def test_prepared_worker_does_not_need_sudo(self):
        result, calls = self.run_fixture()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(calls, '')

    def test_missing_package_explains_admin_requirement(self):
        result, calls = self.run_fixture(missing='libwebkit2gtk-4.1-0')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('administrator', result.stdout + result.stderr)
        self.assertNotIn('apt-get', calls)

    def test_root_installs_only_missing_packages(self):
        result, calls = self.run_fixture(missing='libwebkit2gtk-4.1-0', admin=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('apt-get install -y libwebkit2gtk-4.1-0', calls)
        self.assertNotIn('sudo', calls)

if __name__ == '__main__':
    unittest.main()
