# Sourced by deploy-prod.sh. Never run deployment commands or change its exit status.
NOTIFY_STARTED=$SECONDS
NOTIFY_COMMIT=""
NOTIFY_PREVIOUS=""
NOTIFY_SMOKE=not_run
NOTIFY_RESULT=""
NOTIFY_ATTEMPT=""
NOTIFY_PYTHON="${WHALE_NOTIFY_PYTHON:-python}"
NOTIFY_SPOOL="$REPO_ROOT/.runtime/deploy-notifications"
NOTIFY_ATTEMPT="$("$NOTIFY_PYTHON" "$SCRIPT_DIR/notify_deploy.py" --spool "$NOTIFY_SPOOL" --begin)" ||
  warn "无法建立本机通知记录；请检查 Python 3 与记录目录。"

notify_deploy_result() {
  local code="$1" result="$NOTIFY_RESULT" summary category
  if [ -z "$result" ]; then
    result=failed
    if [ "$code" = 0 ] || [ "$code" -ge 128 ] || [ "$code" = 255 ] ||
       [ "$CURRENT_PHASE" = 7 ] || [ "$CURRENT_PHASE" = 8 ] || [ "$CURRENT_PHASE" = R ]; then
      result=unknown
    fi
  fi
  case "$CURRENT_PHASE" in
    3) category=build ;; 4) category=backup ;; 5) category=upload ;;
    6) category=code_dependencies ;; 7) category=migration_seed ;;
    8) category=switch_start ;; 9) category=smoke ;; R) category=rollback ;;
    10) category=finalize ;; *) category=preflight ;;
  esac
  summary="阶段 ${CURRENT_PHASE} / ${category}，退出码 ${code}"
  local args=(--status "$result" --smoke "$NOTIFY_SMOKE" --summary "$summary"
    --duration-seconds "$((SECONDS - NOTIFY_STARTED))" --spool "$NOTIFY_SPOOL")
  [ -z "$NOTIFY_COMMIT" ] || args+=(--commit "$NOTIFY_COMMIT")
  [ -z "$NOTIFY_PREVIOUS" ] || args+=(--previous-commit "$NOTIFY_PREVIOUS")
  [ -z "$NOTIFY_ATTEMPT" ] || args+=(--attempt "$NOTIFY_ATTEMPT")
  [ -z "${WHALE_NOTIFY_ACTOR:-}" ] || args+=(--actor "$WHALE_NOTIFY_ACTOR")
  "$NOTIFY_PYTHON" "$SCRIPT_DIR/notify_deploy.py" "${args[@]}" ||
    warn "通知未确认；保留原部署退出码 $code。请按原 UUID --check，勿盲目补发。"
  return 0
}

# Only a live service with matching artifact metadata may establish a runtime SHA.
# Git HEAD alone is never evidence (artifact rollback deliberately leaves HEAD unchanged).
verify_runtime_commit() {
  local actual
  actual="$(remote_script <<'REMOTE'
set -e
cd /opt/zafu-pchospital-web
systemctl is-active --quiet zafu-pchospital-web
test "$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:3311/)" = 200
test "$(sed -n 's/^build_id=//p' .next/DEPLOY_COMMIT)" = "$(cat .next/BUILD_ID)"
sed -n 's/^commit=//p' .next/DEPLOY_COMMIT
REMOTE
)" || return 1
  [[ "$actual" =~ ^[a-fA-F0-9]{40}$ ]] || return 1
  NOTIFY_COMMIT="$actual"
}
