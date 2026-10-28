"""docs-sync 产物 revision 标记的 fake-FS 测试（不联网、不碰生产）。"""
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "tools/docs-sync/sync-handbook.sh"
BASH = shutil.which("bash")
SHA = "7f960ed41d079b9945b7af543d9987a1ca062708"


def write_exec(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")
    os.chmod(path, 0o755)


@unittest.skipUnless(BASH, "docs-sync fake-FS test needs bash")
class DocsSyncMarkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.app = self.root / "app"
        self.handbook = self.app / "public/handbook"
        self.handbook.mkdir(parents=True)
        self.state = self.root / "state"
        self.state.mkdir()
        self.tools = self.root / "tools"
        self.tools.joinpath("tools").mkdir(parents=True)
        (self.tools / "tools/handbook.mjs").write_text("// fake helper\n", encoding="utf-8")
        self.bin = self.root / "bin"
        write_exec(
            self.bin / "git",
            '#!/usr/bin/env bash\n'
            'if [ "${1:-}" = "ls-remote" ]; then\n'
            '  printf "%s\\t%s\\n" "$FAKE_DOCS_SHA" "refs/heads/gh-pages"\n'
            "  exit 0\n"
            "fi\n"
            'echo "fake git: unsupported" >&2\n'
            "exit 1\n",
        )
        write_exec(
            self.bin / "node",
            "#!/usr/bin/env bash\n"
            'case "$*" in\n'
            "  *verify*) exit 0 ;;\n"
            '  *prepare*) echo "/tmp/fake-theme.css" ;;\n'
            "esac\n"
            "exit 0\n",
        )
        write_exec(self.bin / "curl", "#!/usr/bin/env bash\nexit 1\n")
        # Git Bash 没有 flock/GNU timeout；Linux 用系统实现，其余平台用最小替身。
        if os.name == "nt" or not shutil.which("flock"):
            write_exec(self.bin / "flock", "#!/usr/bin/env bash\nexit 0\n")
        if os.name == "nt":
            write_exec(self.bin / "timeout", '#!/usr/bin/env bash\nshift\nexec "$@"\n')
        (self.state / "deployed-sha").write_text(SHA + "\n", encoding="utf-8")
        (self.handbook / "index.html").write_text("<html>old</html>\n", encoding="utf-8")

    def run_sync(self):
        env = os.environ.copy()
        env.update(
            {
                "PATH": str(self.bin) + os.pathsep + env.get("PATH", ""),
                "FAKE_DOCS_SHA": SHA,
                "DOCS_SYNC_APP_DIR": str(self.app),
                "DOCS_SYNC_TOOLS_DIR": str(self.tools),
                "DOCS_SYNC_STATE_DIR": str(self.state),
                "DOCS_SYNC_BASE_URL": "http://example.test/handbook/",
                "PYTHONUTF8": "1",
            }
        )
        return subprocess.run(
            [BASH, str(SCRIPT)],
            cwd=self.root,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
        )

    def write_marker(self, value):
        (self.handbook / ".pc-hospital-docs-revision").write_text(value + "\n", encoding="utf-8")

    def test_matching_marker_exits_without_download(self):
        self.write_marker(SHA)
        result = self.run_sync()
        output = result.stdout + result.stderr
        self.assertEqual(result.returncode, 0, output)
        self.assertIn("无变化且内容标记/HTTP 校验通过", output)
        self.assertNotIn("下载失败", output)

    def test_missing_or_stale_marker_forces_resync(self):
        for marker in (None, "a" * 40):
            with self.subTest(marker=marker):
                if marker is None:
                    path = self.handbook / ".pc-hospital-docs-revision"
                    path.unlink(missing_ok=True)
                else:
                    self.write_marker(marker)
                result = self.run_sync()
                output = result.stdout + result.stderr
                self.assertNotEqual(result.returncode, 0, output)
                self.assertIn("内容标记或 HTTP 校验不一致", output)
                self.assertIn("下载失败", output)


if __name__ == "__main__":
    unittest.main()
