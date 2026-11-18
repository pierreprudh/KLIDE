#!/usr/bin/env python3
"""Exercise the actual installer and reconnect to the daemon it spawned."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
sys.dont_write_bytecode = True
import tempfile

sys.path.insert(0, str(Path(__file__).parent))
import importlib.util
spec = importlib.util.spec_from_file_location("remote_smoke", Path(__file__).with_name("remote-machine-smoke.py"))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


def main():
    binary = Path(sys.argv[1] if len(sys.argv) > 1 else "src-tauri/target/debug/klide").resolve()
    installer = Path(__file__).resolve().parents[1] / "scripts/remote-host/install-host.sh"
    signature = subprocess.check_output([str(binary), "ptyd", "version"], text=True).strip()
    with tempfile.TemporaryDirectory(prefix="klide-install-") as directory:
        root = Path(directory)
        commands = root / "commands"
        commands.mkdir()
        bindir = root / ".klide/bin"
        bindir.mkdir(parents=True)
        staged = bindir / ("klide-stage.exe" if os.name == "nt" else "klide-stage")
        shutil.copy2(binary, staged)
        env = dict(os.environ, HOME=str(root), PATH=str(commands) + os.pathsep + os.environ["PATH"])
        installed = bindir / ("klide.exe" if os.name == "nt" else "klide")
        def install(stage, expected):
            if os.name == "nt":
                return [str(stage), "ptyd", "install", "--expected", expected, "--destination", str(installed), "--data-dir", str(root / ".klide/run-host")]
            return ["sh", str(installer), str(stage), expected]
        result = subprocess.run(install(staged, signature), env=env,
                                stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30)
        assert result.returncode == 0, result.stderr
        pid = None
        relay = smoke.Relay(installed, root / ".klide/run-host", env)
        try:
            relay.send({"type": "ping"})
            reply = relay.read(timeout=5)
            assert reply["type"] == "pong", reply
            pid = reply["pid"]
            print("PASS: installed host releases the upgrade lock and accepts a fresh relay", flush=True)
            rejected = bindir / ("klide-wrong-version.exe" if os.name == "nt" else "klide-wrong-version")
            os.link(installed, rejected)
            result = subprocess.run(install(rejected, "wrong revision"), env=env,
                                    stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=10)
            assert result.returncode != 0 and "does not match" in result.stderr, result
            assert installed.exists()
            if os.name != "nt":
                assert not rejected.exists()
            relay.send({"type": "ping"})
            assert relay.read()["pid"] == pid
            print("PASS: a mismatched binary leaves the existing host running", flush=True)
            # Replace an idle host while its old relay still maps the installed
            # executable. Windows must wait for that relay to release the image.
            replacement = bindir / ("klide-replacement.exe" if os.name == "nt" else "klide-replacement")
            shutil.copy2(binary, replacement)
            result = subprocess.run(install(replacement, signature), env=env,
                                    stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30)
            assert result.returncode == 0, result.stderr
            relay.close()
            relay = smoke.Relay(installed, root / ".klide/run-host", env)
            relay.send({"type": "ping"})
            updated = relay.read()
            assert updated["type"] == "pong" and updated["pid"] != pid, updated
            pid = updated["pid"]
            print("PASS: an idle upgrade releases the old executable and starts a reconnectable host", flush=True)
            relay.send({"type": "shutdown"})
            assert relay.read()["type"] == "ok"
        finally:
            relay.close()
            if pid and os.name == "nt":
                smoke.wait_for_exit(pid)
            if pid and os.name != "nt":
                try:
                    os.kill(pid, 15)
                except ProcessLookupError:
                    pass


if __name__ == "__main__":
    main()
