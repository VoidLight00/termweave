#!/usr/bin/env python3
"""Control only TermWeave's pinned, isolated OpenRig daemon. Preserve tmux seats."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import urllib.request

VERSION = "0.6.7"
PORT = 7338


def health():
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f"http://127.0.0.1:{PORT}/healthz", timeout=2) as response:
            value = json.load(response)
        return value if value.get("status") == "ok" and value.get("semver") == VERSION else None
    except Exception:
        return None


def ownership(state, package):
    """Do not trust a persisted PID alone: it can belong to another process now."""
    path = state / "data/daemon.json"
    if not path.exists():
        return "absent"
    try:
        if path.is_symlink():
            return "unknown"
        value = json.loads(path.read_text())
        if value.get("host") != "127.0.0.1" or value.get("port") != PORT:
            return "unknown"
        pid = value.get("pid")
        if type(pid) is not int or pid <= 1:
            return "unknown"
        check = subprocess.run(["ps", "-p", str(pid), "-o", "uid=,command="], capture_output=True, timeout=5)
        if check.returncode == 1 and not check.stdout.strip():
            return "absent"
        parts = check.stdout.decode("utf-8", "replace").strip().split(None, 1)
        expected = str(package / "daemon/dist/index.js")
        if len(parts) == 2 and parts[0] == str(os.getuid()) and parts[1].rstrip().endswith(expected):
            return "owned"
    except Exception:
        pass
    return "unknown"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("status", "start", "stop"))
    args = parser.parse_args()
    base = Path.home()
    state = base / ".local/state/termweave-openrig"
    package = base / ".local/share/termweave-openrig/node_modules/@openrig/cli"
    node = shutil.which("node")
    try:
        metadata = json.loads((package / "package.json").read_text())
        available = bool(node and metadata.get("name") == "@openrig/cli" and metadata.get("version") == VERSION)
    except Exception:
        available = False
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state / "service-control.lock").open("a") as lock:
        os.chmod(lock.name, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({"available": available, "running": False, "error": "service_busy"}))
            return
        owner = ownership(state, package)
        checked = health()
        if args.action != "status":
            if not available or owner == "unknown" or (checked and owner != "owned"):
                print(json.dumps({"available": available, "running": bool(checked), "error": "service_not_owned" if available else "package_missing"}))
                return
            if not ((args.action == "start" and checked) or (args.action == "stop" and owner == "absent" and not checked)):
                env = dict(os.environ)
                for key in list(env):
                    if key.startswith(("OPENRIG_", "RIGGED_", "HERDR_")):
                        del env[key]
                # macOS locates the account keychain through the real HOME. Provider
                # config stays isolated through its explicit supported variables.
                for name, directory in (("OPENRIG_HOME", "data"),
                                        ("CODEX_HOME", "codex"), ("CLAUDE_CONFIG_DIR", "claude")):
                    target = state / directory
                    target.mkdir(parents=True, exist_ok=True, mode=0o700)
                    env[name] = str(target)
                env["HERDR_SOCKET_PATH"] = str(base / ".config/herdr/herdr.sock")
                command = [node, str(package / "dist/bin-wrapper.js"), "daemon", args.action]
                if args.action == "start":
                    command.extend(["--no-kernel", "--host", "127.0.0.1", "--port", str(PORT)])
                try:
                    result = subprocess.run(command, env=env, capture_output=True, timeout=60)
                    # CLI output can contain paths and runtime details. Do not return it through the API.
                    failed = result.returncode != 0
                except subprocess.TimeoutExpired:
                    failed = True
                owner = ownership(state, package)
                checked = health()
                if failed:
                    print(json.dumps({"available": available, "running": bool(checked), "error": "service_control_failed"}))
                    return
        running = bool(checked and owner == "owned")
        error = "service_state_unknown" if owner == "unknown" or (owner == "owned" and not checked) or (checked and owner != "owned") else None
        print(json.dumps({"available": available, "running": running, "version": VERSION,
                          **({"error": error} if error else {})}))


if __name__ == "__main__":
    main()
