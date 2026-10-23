#!/usr/bin/env python3
"""Self-check for termweave-resurrect resume decisions. Run: python3 tools/resurrect/test_resurrect.py"""
import base64, importlib.machinery, importlib.util, json, sys, tempfile
from pathlib import Path

sys.dont_write_bytecode = True
src = Path(__file__).with_name("termweave-resurrect")
loader = importlib.machinery.SourceFileLoader("resurrect", str(src))
r = importlib.util.module_from_spec(importlib.util.spec_from_loader("resurrect", loader))
loader.exec_module(r)

ID = "0123abcd-0000-4000-8000-00000000beef"
b64 = lambda s: base64.b64encode(s.encode()).decode()
TPL = "'/a b/vmix' gpt-x --resume {id}"

# vmix-style wrapper: hint wins, path with a space stays quoted, pane is found
env = f"node claude --settings {{}} TERMWEAVE_RESUME_CMD_B64={b64(TPL)} TERMWEAVE_RESUME_HEALTH=http://127.0.0.1:3456/ ANTHROPIC_BASE_URL=http://127.0.0.1:5999 HERDR_PANE_ID=w1:p1"
hint = r.launcher(env)
assert r.pane_of(env) == "w1:p1"
assert hint == {"proxied": True, "resume": TPL, "health": "http://127.0.0.1:3456/"}, hint
assert r.resume_cmd({"kind": "claude", "id": ID, "cwd": "/w", **hint}) == f"cd '/w' && '/a b/vmix' gpt-x --resume {ID}"
# a session id that is not a UUID never reaches the shell
assert r.resume_cmd({"kind": "claude", "id": "$(touch /tmp/x)", **hint}) is None
# proxied without a hint, or with an unreadable hint: leave the pane empty
assert r.resume_cmd({"kind": "claude", "id": ID, **r.launcher("claude ANTHROPIC_BASE_URL=http://x")}) is None
assert r.resume_cmd({"kind": "claude", "id": ID, **r.launcher("claude TERMWEAVE_RESUME_CMD_B64=%%%")}) is None
# a similar name is not the proxy variable
assert r.launcher("claude XANTHROPIC_BASE_URL=http://x") == {}
# plain agents keep the old behavior
assert r.resume_cmd({"kind": "claude", "id": ID}) == f"claude --resume {ID}"
assert r.resume_cmd({"kind": "codex", "id": None}) == "codex resume --last"
# codex started with a provider profile is proxied even without env variables
assert r.launcher("", "codex --profile router") == {"proxied": True}
assert r.launcher("", "codex -c model_provider=litellm") == {"proxied": True}
assert r.launcher("", "codex resume") == {}

# restore: a dead health URL is waited for once and leaves its panes empty
calls = []
def fake_run(*cmd, timeout=15):
    calls.append(cmd)
    if cmd[:3] == (r.HERDR, "pane", "list"):
        return 0, json.dumps({"result": {"panes": [{"pane_id": p} for p in ("a", "b", "c", "d")]}})
    if cmd[0] == "curl":
        return 0, "000"
    return 0, ""
r.run, r.time.sleep, r.boot_id = fake_run, lambda s: None, lambda: "new"
with tempfile.TemporaryDirectory() as d:
    r.STATE, r.LOG = Path(d, "s.json"), Path(d, "log")
    dead = {"kind": "claude", "id": ID, "resume": TPL, "health": "http://127.0.0.1:1/"}
    r.STATE.write_text(json.dumps({"boot": "old", "panes": {
        "a": dead, "b": dead, "c": {"kind": "claude", "id": ID, "proxied": True}, "d": {"kind": "claude", "id": ID}}}))
    r.restore()
    ran = [c[3] for c in calls if c[:3] == (r.HERDR, "pane", "run")]
    assert ran == ["d"], ran
    assert sum(c[0] == "curl" for c in calls) == 60  # one 120s wait shared by a and b
    log = r.LOG.read_text()
    assert log.count("did not answer") == 2 and "left empty" in log and "c claude" in log
    assert json.loads(r.STATE.read_text())["boot"] == "new"
print("test_resurrect: ok")
