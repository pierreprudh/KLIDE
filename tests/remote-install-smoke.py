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
        if not shutil.which("flock"):
            # macOS has flock(2), but does not ship the Linux flock CLI. This
            # shim uses the inherited open-file description just like that CLI.
            flock = commands / "flock"
            flock.write_text("#!/usr/bin/env python3\nimport fcntl, sys\nfcntl.flock(int(sys.argv[-1]), fcntl.LOCK_EX)\n")
            flock.chmod(0o700)
        bindir = root / ".klide/bin"
        bindir.mkdir(parents=True)
        staged = bindir / "klide-stage"
        shutil.copy2(binary, staged)
        env = dict(os.environ, HOME=str(root), PATH=str(commands) + ":" + os.environ["PATH"])
        result = subprocess.run(["sh", str(installer), str(staged), signature], env=env,
                                stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30)
        assert result.returncode == 0, result.stderr
        installed = bindir / "klide"
        pid = None
        relay = smoke.Relay(installed, root / ".klide/run-host", env)
        try:
            relay.send({"type": "ping"})
            reply = relay.read(timeout=5)
            assert reply["type"] == "pong", reply
            pid = reply["pid"]
            print("PASS: installed host releases the upgrade lock and accepts a fresh relay", flush=True)
            rejected = bindir / "klide-wrong-version"
            os.link(installed, rejected)
            result = subprocess.run(["sh", str(installer), str(rejected), "wrong revision"], env=env,
                                    stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=10)
            assert result.returncode != 0 and "does not match" in result.stderr, result
            assert installed.exists() and not rejected.exists()
            relay.send({"type": "ping"})
            assert relay.read()["pid"] == pid
            print("PASS: a mismatched binary leaves the existing host running", flush=True)
            relay.send({"type": "shutdown"})
            assert relay.read()["type"] == "ok"
        finally:
            relay.close()
            if pid:
                try:
                    os.kill(pid, 15)
                except ProcessLookupError:
                    pass


if __name__ == "__main__":
    main()
