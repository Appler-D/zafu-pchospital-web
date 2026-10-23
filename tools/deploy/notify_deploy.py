"""One-shot whale result notifier (standard library). 202 means queued, not delivered/read."""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ENDPOINT = "https://astrbot.pczafu.cn/integrations/whale-deploy"
REPOSITORY = "ZAFU-PCHospital/zafu-pchospital-web"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward Bearer credentials to a redirect target.


def save_once(folder, payload):
    folder.mkdir(parents=True, exist_ok=True)
    filename = folder / (str(uuid.UUID(payload["operation_id"])) + ".json")
    try:
        with filename.open("x", encoding="utf-8") as stream:
            json.dump(payload, stream, ensure_ascii=False, sort_keys=True, indent=2)
    except FileExistsError:
        if json.loads(filename.read_text(encoding="utf-8")) != payload:
            raise ValueError("Immutable operation conflict")
    return filename


def validate(payload):
    allowed = {"operation_id", "repository", "status", "commit", "previous_commit", "smoke",
               "duration_seconds", "actor", "summary", "dry_run"}
    if set(payload) - allowed or payload.get("repository") != REPOSITORY:
        raise ValueError("Invalid payload")
    uuid.UUID(payload["operation_id"])
    if payload.get("status") not in ("success", "failed", "rollback", "unknown"):
        raise ValueError("Invalid status")
    if payload.get("smoke") not in ("passed", "failed", "not_run", "unknown"):
        raise ValueError("Invalid smoke")
    for key in ("commit", "previous_commit"):
        if key in payload and not re.fullmatch(r"[a-fA-F0-9]{7,40}", payload[key]):
            raise ValueError("Invalid SHA")
    if payload["status"] in ("success", "rollback"):
        if not payload.get("commit") or payload["smoke"] != "passed":
            raise ValueError("Verified commit and passed smoke required")
    for key, limit in (("actor", 60), ("summary", 240)):
        if key in payload and (not isinstance(payload[key], str) or len(payload[key]) > limit):
            raise ValueError("Invalid text")
    duration = payload.get("duration_seconds", 0)
    if not isinstance(duration, (int, float)) or not 0 <= duration <= 86400:
        raise ValueError("Invalid duration")
    if len(json.dumps(payload).encode()) > 4096:
        raise ValueError("Payload too large")


def main(argv=None, opener=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=os.environ.get("WHALE_NOTIFY_CONFIG", ""))
    parser.add_argument("--operation-id")
    parser.add_argument("--status", choices=["success", "failed", "rollback", "unknown"])
    parser.add_argument("--commit")
    parser.add_argument("--previous-commit")
    parser.add_argument("--duration-seconds", type=float)
    parser.add_argument("--actor")
    parser.add_argument("--smoke", default="unknown", choices=["passed", "failed", "not_run", "unknown"])
    parser.add_argument("--summary")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--payload", help="Saved immutable payload; never automatically retry")
    parser.add_argument("--check", metavar="UUID", help="Read status only; 404 is not proof of nonexecution")
    parser.add_argument("--spool", default=".runtime/deploy-notifications")
    parser.add_argument("--begin", action="store_true", help="Local attempt journal only; no network")
    parser.add_argument("--attempt", help="Local attempt UUID, retained across interruption")
    args = parser.parse_args(argv)
    operation = None
    try:
        folder = Path(args.spool)
        if args.begin:
            attempt = str(uuid.uuid4())
            folder.mkdir(parents=True, exist_ok=True)
            (folder / ("attempt-" + attempt + ".json")).write_text(
                json.dumps({"attempt": attempt, "state": "running"}), encoding="utf-8")
            print(attempt)
            return 0
        if args.check:
            operation = str(uuid.UUID(args.check))
            payload = None
        else:
            if args.payload:
                payload = json.loads(Path(args.payload).read_text(encoding="utf-8-sig"))
            else:
                payload = {"operation_id": str(uuid.UUID(args.operation_id)) if args.operation_id else str(uuid.uuid4()),
                           "repository": REPOSITORY, "status": args.status, "smoke": args.smoke}
                for key in ("commit", "previous_commit", "duration_seconds", "actor", "summary"):
                    value = getattr(args, key)
                    if value is not None:
                        payload[key] = value
                if args.status == "rollback" and (folder / "last-failure").exists():
                    related = str(uuid.UUID((folder / "last-failure").read_text().strip()))
                    payload["summary"] = (payload.get("summary", "") + "；关联失败 " + related)[:240]
            if args.dry_run:
                payload["dry_run"] = True
            validate(payload)
            operation = payload["operation_id"]
            if not args.dry_run:
                save_once(folder, payload)  # Persist BEFORE config/network, including missing-config failures.
                if args.attempt:
                    attempt = str(uuid.UUID(args.attempt))
                    (folder / ("attempt-" + attempt + ".json")).write_text(
                        json.dumps({"attempt": attempt, "state": "finished", "operation_id": operation}), encoding="utf-8")
                if payload["status"] in ("failed", "unknown"):
                    (folder / "last-failure").write_text(operation, encoding="utf-8")
        if os.environ.get("WHALE_NOTIFY_DISABLED") == "1":
            print("通知已关闭；仅保留本机记录。")
            return 0
        if not args.config:
            raise ValueError("WHALE_NOTIFY_CONFIG required")
        config = json.loads(Path(args.config).read_text(encoding="utf-8-sig"))
        if config["url"].rstrip("/") != ENDPOINT or not isinstance(config["token"], str) or not config["token"]:
            raise ValueError("Invalid private config")
        request = urllib.request.Request(
            ENDPOINT + ("/" + operation if args.check else ""),
            data=None if payload is None else json.dumps(payload).encode(),
            headers={"Authorization": "Bearer " + config["token"], "Content-Type": "application/json"},
            method="GET" if args.check else "POST")
        transport = opener or urllib.request.build_opener(NoRedirect()).open
        with transport(request, timeout=12) as response:
            result = json.loads(response.read(4096))
            # Do not echo arbitrary response bodies, headers, or error details.
            status = result.get("state" if args.check else "delivery")
            safe_status = status if status in ("pending", "sending", "accepted", "rejected", "unknown") else "unreported"
            print(f"HTTP {response.status}; operation_id={operation}; delivery={safe_status}")
            if response.status == 202:
                print("结果已持久入队；不代表 QQ 接收或用户已读。")
        return 0
    except Exception as exc:
        detail = "HTTP " + str(exc.code) if isinstance(exc, urllib.error.HTTPError) else type(exc).__name__
        print("通知未确认：" + detail + "；不改变部署结果，不自动补发。", file=sys.stderr)
        return 2
    finally:
        if operation:
            print("核对投递：python tools/deploy/notify_deploy.py --check " + operation)


if __name__ == "__main__":
    sys.exit(main())
