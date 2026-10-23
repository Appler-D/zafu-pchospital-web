"""Local substitutes only: never deploy or contact the real receiver."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "tools/deploy/notify_deploy.py"
spec = importlib.util.spec_from_file_location("notify_deploy", SCRIPT)
notify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notify)
SHA = "a" * 40


class Response:
    def __init__(self, body=None, status=202):
        self.status = status
        self.body = body if body is not None else {"delivery": "pending", "untrusted": "secret-must-not-appear"}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self, size):
        return json.dumps(self.body).encode()


class NotifyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.config = self.folder / "private.json"
        self.config.write_text(json.dumps({"url": notify.ENDPOINT, "token": "secret-must-not-appear"}))
        self.args = ["--config", str(self.config), "--spool", str(self.folder / "spool")]

    def invoke(self, args, opener):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            code = notify.main(self.args + args, opener=opener)
        self.assertNotIn("secret-must-not-appear", output.getvalue())
        return code, output.getvalue()

    def test_one_shot_timeout_persists_payload_then_check_only(self):
        calls = []

        def timeout(request, timeout):
            calls.append(request)
            self.assertEqual(timeout, 12)
            raise TimeoutError("secret-must-not-appear")

        code, output = self.invoke(["--status", "success", "--commit", SHA, "--smoke", "passed"], timeout)
        self.assertEqual(code, 2)
        saved = list((self.folder / "spool").glob("*.json"))
        self.assertEqual(len(saved), 1)
        payload = json.loads(saved[0].read_text(encoding="utf-8"))
        self.assertIn(payload["operation_id"], output)
        self.assertEqual(len(calls), 1)

        def check(request, timeout):
            self.assertEqual(request.method, "GET")
            self.assertIsNone(request.data)
            return Response({"state": "accepted", "untrusted": "secret-must-not-appear"}, status=200)

        code, output = self.invoke(["--check", payload["operation_id"]], check)
        self.assertEqual(code, 0)
        self.assertIn("delivery=accepted", output)
        self.assertNotIn("unreported", output)
        self.assertNotIn("结果已持久入队", output)

    def test_rollback_new_uuid_links_failure_and_immutable_conflict(self):
        for status in ("failed", "rollback"):
            args = ["--status", status, "--smoke", "passed", "--commit", SHA]
            code, output = self.invoke(args, lambda *a, **k: Response())
            self.assertEqual(code, 0)
            self.assertIn("delivery=pending", output)
            self.assertNotIn("unreported", output)
        payloads = [json.loads(path.read_text(encoding="utf-8")) for path in (self.folder / "spool").glob("*.json")]
        failure = next(p for p in payloads if p["status"] == "failed")
        rollback = next(p for p in payloads if p["status"] == "rollback")
        self.assertNotEqual(failure["operation_id"], rollback["operation_id"])
        self.assertIn(failure["operation_id"], rollback["summary"])
        self.assertEqual(self.invoke(["--status", "unknown", "--operation-id", failure["operation_id"]],
                                     lambda *a, **k: self.fail("conflict must not send"))[0], 2)

    def test_dry_run_no_spool_and_missing_config_keeps_real_payload(self):
        seen = []

        def accepted(request, timeout):
            seen.append(json.loads(request.data))
            return Response()

        self.assertEqual(self.invoke(["--status", "unknown", "--dry-run"], accepted)[0], 0)
        self.assertTrue(seen[0]["dry_run"])
        self.assertFalse((self.folder / "spool").exists())
        self.config.unlink()
        self.assertEqual(self.invoke(["--status", "unknown"], accepted)[0], 2)
        self.assertEqual(len(list((self.folder / "spool").glob("*.json"))), 1)

    def test_real_exit_hook_stages_preserve_exit_code_even_notification_timeout(self):
        bash = str(Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe") if os.name == "nt" else shutil.which("bash")
        if not bash or not Path(bash).exists():
            self.skipTest("Bash unavailable")
        # Load the actual EXIT handler, stopping before the first deployment command.
        prefix = (ROOT / "tools/deploy/deploy-prod.sh").read_text(encoding="utf-8").split("trap on_exit EXIT")[0]
        adapter = self.folder / "adapter.py"
        adapter.write_text(
            "import importlib.util,sys\n"
            "spec=importlib.util.spec_from_file_location('n',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\n"
            "def timeout(*a,**kw):\n assert kw['timeout']==12\n raise TimeoutError('secret-must-not-appear')\n"
            "sys.exit(m.main(sys.argv[2:],opener=timeout))\n", encoding="utf-8")
        wrapper = self.folder / "python-substitute"
        wrapper.write_text(f'#!/usr/bin/env bash\nexec "{Path(sys.executable).as_posix()}" "{adapter.as_posix()}" "$@"\n', encoding="utf-8")
        wrapper.chmod(0o700)
        for phase, code, result, smoke in [(10, 0, "success", "passed"), (3, 1, "", "not_run"),
                                           (5, 1, "", "not_run"), (7, 1, "", "not_run"),
                                           (8, 255, "", "unknown"), (9, 1, "", "failed"),
                                           ("R", 0, "rollback", "passed")]:
            with self.subTest(phase=phase):
                spool = self.folder / ("stage-" + str(phase))
                script = self.folder / "exercise.sh"
                script.write_text(prefix + f'''
SCRIPT_DIR='{(ROOT / 'tools/deploy').as_posix()}'
REPO_ROOT='{self.folder.as_posix()}'
WHALE_NOTIFY_PYTHON='{wrapper.as_posix()}'
export WHALE_NOTIFY_CONFIG='{self.config.as_posix()}'
source "$SCRIPT_DIR/notify-result.sh"
NOTIFY_SPOOL='{spool.as_posix()}'
CURRENT_PHASE='{phase}'
NOTIFY_RESULT='{result}'
NOTIFY_SMOKE='{smoke}'
NOTIFY_COMMIT='{SHA if result else ''}'
trap on_exit EXIT
exit {code}
''', encoding="utf-8")
                run = subprocess.run([bash, str(script)], capture_output=True, text=True, encoding="utf-8", env={**os.environ, "PYTHONUTF8": "1"})
                self.assertEqual(run.returncode, code, run.stdout + run.stderr)
                self.assertNotIn("secret-must-not-appear", run.stdout + run.stderr)
                payload = next(json.loads(p.read_text(encoding="utf-8")) for p in spool.glob("*.json") if not p.name.startswith("attempt-"))
                self.assertEqual(payload["status"], result or ("unknown" if phase in (7, 8) else "failed"))
                self.assertEqual(payload["smoke"], smoke)
                self.assertNotIn("commit", payload) if not result else self.assertEqual(payload["commit"], SHA)


if __name__ == "__main__":
    unittest.main()
