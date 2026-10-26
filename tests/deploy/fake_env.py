"""Local stand-ins for tools/deploy/deploy-prod.sh tests.

Every command is rewritten into a temporary sandbox. The module never opens a
network connection and never touches the real /opt, systemd, Docker or pnpm.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path

APP = Path(os.environ["FAKE_APP_DIR"])
SANDBOX = Path(os.environ["FAKE_SANDBOX"])
SERVER_OPT = APP.parent
TMP = Path(os.environ["FAKE_SERVER_TMP"])
DB_STATE = Path(os.environ["FAKE_DB_STATE"])
SYSTEMD_STATE = Path(os.environ["FAKE_SYSTEMD_STATE"])
EVENTS = Path(os.environ["FAKE_EVENTS"])
BASH = os.environ.get("FAKE_BASH") or shutil.which("bash")

REPLACEMENTS = {
    "/opt/zafu-pchospital-web": APP.as_posix(),
    "/opt/zafu-pchospital-backups": (SERVER_OPT / "zafu-pchospital-backups").as_posix(),
    "/opt/zafu-pchospital-db": (SERVER_OPT / "zafu-pchospital-db").as_posix(),
    "/opt": SERVER_OPT.as_posix(),
    "/tmp/": TMP.as_posix() + "/",
}
PATH_PATTERN = re.compile("|".join(re.escape(key) for key in sorted(REPLACEMENTS, key=len, reverse=True)))


def translate(text):
    return PATH_PATTERN.sub(lambda match: REPLACEMENTS[match.group(0)], text)


def remote_env():
    env = os.environ.copy()
    env["GIT_CONFIG_GLOBAL"] = str(SANDBOX / "gitconfig")
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    env["PYTHONUTF8"] = "1"
    env["BASH_ENV"] = str(SANDBOX / "remote-shims.sh")
    return env


def option_values(args, options):
    """Return (remaining positional args, map of option -> last value)."""
    values = {}
    positional = []
    index = 0
    while index < len(args):
        arg = args[index]
        if arg in options:
            values[arg] = args[index + 1]
            index += 2
            continue
        if arg.startswith("-"):
            index += 1
            continue
        positional.append(arg)
        index += 1
    return positional, values


def run_ssh(args):
    positional, _ = option_values(args, {"-o", "-i", "-p", "-l"})
    if not positional:
        return 1
    command = " ".join(positional[1:]) if len(positional) > 1 else "true"
    script = sys.stdin.read() if command.strip() == "bash -s" else command
    result = subprocess.run(
        [BASH, "-c", translate(script)],
        text=True,
        encoding="utf-8",
        errors="replace",
        env=remote_env(),
    )
    return result.returncode


def run_scp(args):
    positional, _ = option_values(args, {"-o", "-i", "-P", "-p"})
    if len(positional) < 2:
        return 1
    source, destination = positional[-2], positional[-1]
    target = destination.split(":", 1)[1] if ":" in destination else destination
    target = Path(translate(target))
    if str(target).endswith("/") or destination.endswith("/"):
        target = target / Path(source).name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    return 0


def state_path(unit):
    return SYSTEMD_STATE / (unit.replace("/", "_") + ".state")


def get_state(unit):
    path = state_path(unit)
    if path.exists():
        return path.read_text(encoding="utf-8").strip() or "inactive"
    return "active" if unit.startswith(("zafu-pchospital-web", "docs-sync")) else "inactive"


def set_state(unit, state):
    state_path(unit).parent.mkdir(parents=True, exist_ok=True)
    state_path(unit).write_text(state, encoding="utf-8")
    with EVENTS.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({"unit": unit, "action": state, "time": time.time()}) + "\n")


def run_systemctl(args):
    quiet = "--quiet" in args
    positional = [arg for arg in args if not arg.startswith("-")]
    if not positional:
        return 1
    action, units = positional[0], positional[1:]
    if action == "is-active":
        unit = units[0]
        state = get_state(unit)
        if not quiet:
            print(state)
        return 0 if state == "active" else 3
    if action in ("start", "stop"):
        for unit in units:
            set_state(unit, "active" if action == "start" else "inactive")
        return 0
    print(f"fake systemctl: unsupported action {action}", file=sys.stderr)
    return 1


def db_rows():
    path = DB_STATE / "migrations.txt"
    if not path.exists():
        return []
    return [line for line in path.read_text(encoding="utf-8").splitlines() if line]


def applied_count():
    count = 0
    for line in db_rows():
        parts = line.split("|")
        if len(parts) >= 3 and parts[1] and not parts[2]:
            count += 1
    return count


def table_names():
    return [f"table_{index:02d}" for index in range(1, 31)] + ["_prisma_migrations"]


def fake_dump():
    import random

    rng = random.Random(42)
    lines = ["-- local stand-in dump"]
    for table in table_names():
        lines.append(f"CREATE TABLE `{table}` (`id` int NOT NULL);")
        for _ in range(50):
            lines.append(f"INSERT INTO `{table}` VALUES ('{rng.randbytes(16).hex()}');")
    return "\n".join(lines) + "\n"


def run_mysql(sql):
    normalized = " ".join(sql.split())
    if normalized.upper().startswith("SHOW TABLES"):
        for table in table_names():
            print(table)
        return 0
    if "FROM _prisma_migrations" in normalized and "ORDER BY started_at" in normalized:
        for line in db_rows():
            print(line)
        return 0
    if "FROM _prisma_migrations" in normalized and "COUNT(*)" in normalized.upper():
        print(applied_count())
        return 0
    match = re.search(r"SELECT COUNT\(\*\) FROM `([^`]+)`", normalized, re.IGNORECASE)
    if match:
        print(applied_count() if match.group(1) == "_prisma_migrations" else 7)
        return 0
    print(f"fake mysql: unsupported query: {normalized}", file=sys.stderr)
    return 1


def run_docker(args):
    if args and args[0] == "ps":
        print("zafu-pchospital-db-greatsql-1")
        return 0
    if not args or args[0] != "exec":
        print("fake docker: unsupported invocation", file=sys.stderr)
        return 1
    command = args[2:]
    if "mysqldump" in command:
        print(fake_dump(), end="")
        return 0
    if "mysql" in command:
        _, options = option_values(command, {"-e", "-u", "-p", "-h", "-P"})
        sql = options.get("-e")
        if not sql:
            print("fake mysql: missing -e", file=sys.stderr)
            return 1
        return run_mysql(sql)
    print("fake docker: unsupported exec command", file=sys.stderr)
    return 1


def migration_dirs():
    return sorted(path.name for path in (Path.cwd() / "prisma/migrations").glob("*/") if path.is_dir())


def run_pnpm(args):
    if not args:
        return 1
    command = args[0]
    if command in ("--version", "-v"):
        print("12.4.1")
        return 0
    if command == "install":
        (Path.cwd() / "node_modules").mkdir(exist_ok=True)
        return 0
    if command == "db:generate":
        models = Path.cwd() / "src/generated/prisma/models"
        models.mkdir(parents=True, exist_ok=True)
        (models / "fake-model.ts").write_text("export {};\n", encoding="utf-8")
        return 0
    if command == "db:migrate:deploy":
        DB_STATE.mkdir(parents=True, exist_ok=True)
        path = DB_STATE / "migrations.txt"
        existing = set()
        if path.exists():
            for line in path.read_text(encoding="utf-8").splitlines():
                if line:
                    existing.add(line.split("|", 1)[0])
        with path.open("a", encoding="utf-8") as stream:
            for name in migration_dirs():
                if name not in existing:
                    stream.write(f"{name}|2026-01-01T00:00:00Z|\n")
                    existing.add(name)
        print("fake prisma migrate deploy: applied pending migrations")
        return 0
    if command == "db:seed":
        print("fake prisma db seed: ok")
        return 0
    print(f"fake pnpm: unexpected command {command}", file=sys.stderr)
    return 1


def run_curl(args):
    positional, options = option_values(
        args, {"-o", "-w", "-H", "-d", "-c", "--max-time", "--connect-timeout"}
    )
    url = positional[-1] if positional else ""
    if "-d" in options:
        print(json.dumps({"success": True}))
        return 0
    code = "200"
    if "127.0.0.1:3311" in url and get_state("zafu-pchospital-web") != "active":
        code = "000"
    else:
        fail_path = os.environ.get("FAKE_CURL_FAIL_PATH", "").strip("/")
        if fail_path and urllib.parse.urlparse(url).path.strip("/") == fail_path:
            code = "500"
    if "-w" in options:
        print(code)
    else:
        print("ok")
    return 0


def run_timeout(args):
    if not args:
        return 1
    index = 0
    while index < len(args) and args[index].startswith("-"):
        index += 1
    if index < len(args):
        index += 1  # duration
    if index >= len(args):
        return 1
    return subprocess.run(args[index:], env=os.environ.copy()).returncode


def main():
    tool = sys.argv[1]
    args = sys.argv[2:]
    if tool == "ssh":
        return run_ssh(args)
    if tool == "scp":
        return run_scp(args)
    if tool == "systemctl":
        return run_systemctl(args)
    if tool == "docker":
        return run_docker(args)
    if tool == "pnpm":
        return run_pnpm(args)
    if tool == "curl":
        return run_curl(args)
    if tool == "timeout":
        return run_timeout(args)
    if tool == "node":
        print("v22.12.0")
        return 0
    if tool == "mdbook":
        print("mdbook v0.5.4")
        return 0
    if tool == "free":
        print("              total        used        free      shared  buff/cache   available")
        print("Mem:           1613         500         300          10         800        1000")
        return 0
    if tool == "df":
        print("Filesystem      Size  Used Avail Use% Mounted on")
        print("fake             50G   10G   40G  20% /opt")
        return 0
    if tool == "chown":
        return 0
    print(f"fake_env: unknown tool {tool}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
