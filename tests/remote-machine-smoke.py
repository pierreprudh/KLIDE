#!/usr/bin/env python3
"""Native host acceptance with a controlled Claude CLI, no model calls.

Build the debug klide binary, then run this script with its path. Uses a
temporary checkout, data dir and fake CLI. It never uses the real Claude login.
"""
import json
import faulthandler
import os
from pathlib import Path
import queue
import threading
import subprocess
import sys
import tempfile
import time


class Relay:
    def __init__(self, binary, data, env):
        command = [str(binary), "ptyd", "connect", "--ensure", "--data-dir", str(data)]
        if env.get("KLIDE_SMOKE_SSH_CONFIG"):
            import base64
            quote = lambda value: "'" + str(value).replace("'", "''") + "'"
            script = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $env:PATH=" + quote(env["PATH"]) + "; & " + quote(binary) + " ptyd connect --ensure --data-dir " + quote(data) + "; exit $LASTEXITCODE"
            encoded = base64.b64encode(script.encode("utf-16-le")).decode()
            command = ["ssh", "-F", env["KLIDE_SMOKE_SSH_CONFIG"], "native-smoke", "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand " + encoded]
        self.process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
        )
        self.lines = queue.Queue()
        def read_lines():
            for line in self.process.stdout:
                self.lines.put(line)
            self.lines.put(None)
        threading.Thread(target=read_lines, daemon=True).start()

    def send(self, request):
        self.process.stdin.write(json.dumps(request).encode() + b"\n")
        self.process.stdin.flush()

    def read(self, timeout=15):
        try:
            line = self.lines.get(timeout=timeout)
        except queue.Empty:
            raise AssertionError("Timed out waiting for relay output")
        if line is None:
            self.process.wait(timeout=3)
            raise AssertionError("Relay closed: " + self.process.stderr.read().decode(errors="replace"))
        return json.loads(line)

    def close(self):
        try:
            self.process.stdin.close()
        except BrokenPipeError:
            pass
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()


def main():
    faulthandler.dump_traceback_later(45)
    binary = Path(sys.argv[1] if len(sys.argv) > 1 else "src-tauri/target/debug/klide").resolve()
    with tempfile.TemporaryDirectory(prefix="klide-native-remote-") as directory:
        root = Path(directory)
        checkout = root / "checkout"
        checkout.mkdir()
        for args in [["init", "-q"], ["config", "user.name", "Smoke"], ["config", "user.email", "smoke@example.test"]]:
            subprocess.run(["git", "-C", str(checkout), *args], check=True)
        (checkout / "README.md").write_text("fixture\n")
        subprocess.run(["git", "-C", str(checkout), "add", "."], check=True)
        subprocess.run(["git", "-C", str(checkout), "commit", "-qm", "fixture"], check=True)
        commands = root / "commands"
        commands.mkdir()
        claude = commands / ("fake_claude.py" if os.name == "nt" else "claude")
        claude.write_text("""#!/usr/bin/env python3
import json, os, sys, time
if '--version' in sys.argv:
    print('test Claude'); sys.exit(0)
if 'auth' in sys.argv:
    print('{"loggedIn":true}'); sys.exit(0)
sys.stdin.read()
from pathlib import Path
Path('native-result.txt').write_text('controlled remote result\\n')
def emit(value): print(json.dumps(value), flush=True)
emit({'type':'system','subtype':'init','session_id':'controlled-session'})
for i in range(12):
    emit({'type':'stream_event','event':{'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':f'chunk-{i} '}}})
    time.sleep(.3)
emit({'type':'assistant','message':{'content':[{'type':'text','text':'controlled task completed'}]}})
emit({'type':'result','subtype':'success','result':'controlled task completed','num_turns':1})
""")
        claude.chmod(0o700)
        if os.name == "nt":
            (commands / "claude.cmd").write_text('@echo off\n"' + sys.executable + '" -u "' + str(claude) + '" %*\n')
        env = dict(os.environ, PATH=str(commands) + os.pathsep + os.environ["PATH"])
        data = root / "host"
        daemon = None
        if not env.get("KLIDE_SMOKE_SSH_CONFIG"):
            daemon = subprocess.Popen([str(binary), "ptyd", "--data-dir", str(data)], stdin=subprocess.DEVNULL,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env, start_new_session=True)
        relays = []

        def connect():
            relay = Relay(binary, data, env)
            relays.append(relay)
            return relay

        def request(value):
            relay = connect()
            relay.send(value)
            reply = relay.read()
            relay.close()
            relays.remove(relay)
            return reply

        try:
            for _ in range(100) if daemon else []:
                if (data / "ptyd.token").exists():
                    break
                assert daemon.poll() is None, "Host exited during startup"
                time.sleep(.05)
            print("Checking subscription handshake", flush=True)
            stream = connect()
            stream.send({"type": "subscribe"})
            assert stream.read()["type"] == "subscribed"
            run_id = "native-task"
            spec = {"runId": run_id, "workspaceRoot": "/not/a/remote/path", "mode": "goal", "provider": "claude-code",
                    "model": "default", "initialText": "Say hello slowly", "context": None, "systemPrompt": None}
            print("Starting controlled remote task", flush=True)
            started = request({"type": "remote_start", "request": spec, "checkout": str(checkout)})
            assert started["type"] == "chat_started", started
            first = []
            deadline = time.monotonic() + 20
            while not any(e.get("event", {}).get("type") == "assistant_delta" for e in first):
                assert time.monotonic() < deadline, "No streamed delta within 20 seconds"
                event = stream.read()
                first.append(event)
                assert event.get("event", {}).get("type") != "run_error", event
            stream.close()
            relays.remove(stream)
            # No client connection remains. The host must keep executing.
            time.sleep(.8)
            state = request({"type": "chat_status", "run_id": run_id})
            assert state["status"] is not None, state
            blocked = request({"type": "prepare_upgrade"})
            assert blocked["type"] == "err" and "active" in blocked["message"], blocked
            replay = request({"type": "remote_read", "run_id": run_id, "from_seq": 0, "limit": 256})
            assert replay["type"] == "remote_events", replay
            assert any(e["type"] == "assistant_delta" for e in replay["events"]), replay
            started_event = next(e for e in replay["events"] if e["type"] == "run_started")
            assert Path(started_event["cwd"]).resolve() == (data / "worktrees" / run_id).resolve(), started_event
            stream = connect()
            stream.send({"type": "subscribe"})
            assert stream.read()["type"] == "subscribed"
            # Replay after subscribing closes the disconnect/reconnect gap.
            replay = request({"type": "remote_read", "run_id": run_id, "from_seq": 0, "limit": 256})
            next_seq = replay["next_seq"]
            saw_live = False
            while True:
                event = stream.read()
                if event.get("type") != "chat" or event.get("run_id") != run_id:
                    continue
                if event["seq"] < next_seq:
                    continue
                assert event["seq"] == next_seq, event
                next_seq += 1
                saw_live = True
                if event["event"]["type"] in ("run_result", "run_error"):
                    assert event["event"]["type"] == "run_result", event
                    break
            assert saw_live
            print("PASS: launch → disconnect every client → replay → resume ordered streaming → completion")
            stream.close()
            relays.remove(stream)
            # A fresh process can recover a settled result without any GUI state.
            replay = request({"type": "remote_read", "run_id": run_id, "from_seq": 0, "limit": 256})
            assert replay["events"][-1]["type"] == "run_result"
            changes = request({"type": "remote_changes", "run_id": run_id})
            assert changes["type"] == "remote_changes", changes
            assert "controlled remote result" in changes["diff"], changes
            assert not (checkout / "native-result.txt").exists()
            print("PASS: isolated worktree, active-upgrade refusal, completed-task recovery")
            followup = request({"type": "remote_start", "request": spec, "checkout": str(checkout)})
            assert followup["type"] == "chat_started", followup
            assert followup["from_seq"] == len(replay["events"]), followup
            stopped = request({"type": "chat_control", "run_id": run_id, "control": {"type": "stop"}})
            assert stopped["type"] == "chat_controlled", stopped
            for _ in range(100):
                if request({"type": "chat_status", "run_id": run_id})["status"] is None:
                    break
                time.sleep(.05)
            else:
                raise AssertionError("Stop did not settle the remote task")
            print("PASS: follow-up reuses conversation history and Stop works after reattachment")
        finally:
            for relay in relays:
                relay.close()
            if daemon:
                daemon.terminate()
                try:
                    daemon.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    daemon.kill()
                    daemon.wait()
            else:
                request({"type": "shutdown"})
                # The host releases Windows worktree handles asynchronously.
                for _ in range(100):
                    if not (data / "ptyd.endpoint").exists(): break
                    time.sleep(.05)


if __name__ == "__main__":
    main()
