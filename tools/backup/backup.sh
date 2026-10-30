#!/usr/bin/env bash
#
# 定时备份：GreatSQL + 上传文件 + 配置。
# 只做本地备份；保留策略与磁盘闸门在本脚本内，告警通过 ALERT_HOOK 交给外部 QQ bot。
# 安装/恢复/告警交接见 tools/backup/README.md。
#
set -euo pipefail
umask 077

CONFIG="${ZAFU_BACKUP_CONFIG:-/etc/zafu-backup.conf}"
DRY_RUN=0

usage() {
  cat <<'EOF'
用法：zafu-backup [--dry-run] [--help]
  --dry-run  只做配置/路径/磁盘检查，不写备份
  --help     显示帮助
EOF
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

[ -f "$CONFIG" ] || { echo "缺少配置：$CONFIG" >&2; exit 1; }
# shellcheck source=/dev/null
. "$CONFIG"

BACKUP_ROOT="${BACKUP_ROOT:-/opt/zafu-pchospital-backups/scheduled}"
APP_DIR="${APP_DIR:-/opt/zafu-pchospital-web}"
DB_CONTAINER="${DB_CONTAINER:-zafu-pchospital-db-greatsql-1}"
DB_NAME="${DB_NAME:-zafu_pchospital}"
DB_ENV_FILE="${DB_ENV_FILE:-/opt/zafu-pchospital-db/.env}"
UPLOADS_DIR="${UPLOADS_DIR:-$APP_DIR/storage/uploads}"
STATE_DIR="${STATE_DIR:-/var/lib/zafu-backup}"
RETENTION_DAILY="${RETENTION_DAILY:-14}"
RETENTION_WEEKLY="${RETENTION_WEEKLY:-8}"
RETENTION_MONTHLY="${RETENTION_MONTHLY:-6}"
MIN_FREE_BYTES="${MIN_FREE_BYTES:-5368709120}"
MAX_SCHEDULED_BYTES="${MAX_SCHEDULED_BYTES:-1073741824}"
DISK_WARN_PCT="${DISK_WARN_PCT:-85}"
MIN_TABLES="${MIN_TABLES:-27}"
ALERT_HOOK="${ALERT_HOOK:-}"
ALERT_ON_SUCCESS="${ALERT_ON_SUCCESS:-0}"

is_uint() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; }
for pair in \
  "RETENTION_DAILY=$RETENTION_DAILY" \
  "RETENTION_WEEKLY=$RETENTION_WEEKLY" \
  "RETENTION_MONTHLY=$RETENTION_MONTHLY" \
  "MIN_FREE_BYTES=$MIN_FREE_BYTES" \
  "MAX_SCHEDULED_BYTES=$MAX_SCHEDULED_BYTES" \
  "DISK_WARN_PCT=$DISK_WARN_PCT" \
  "MIN_TABLES=$MIN_TABLES"; do
  is_uint "${pair#*=}" || { echo "配置项必须是非负整数：${pair%%=*}" >&2; exit 1; }
done

STATUS_FILE="$STATE_DIR/status.json"
DAILY_DIR=""
KEEP_DIR=0
log() { printf '[zafu-backup] %s\n' "$*"; }
warn() { printf '[zafu-backup] WARN: %s\n' "$*" >&2; }

free_bytes() { df -B1 --output=avail "$BACKUP_ROOT" | tail -1 | tr -d '[:space:]'; }
used_pct() { df --output=pcent "$BACKUP_ROOT" | tail -1 | tr -dc '0-9'; }
scheduled_bytes() { du -sb "$BACKUP_ROOT" 2>/dev/null | awk '{print $1}' || echo 0; }

json_escape() {
  printf '%s' "$1" | tr '\n\r\t' '   ' | sed 's/\\/\\\\/g; s/"/\\"/g'
}

write_status() {
  local status="$1" message="$2"
  local tmp="$STATE_DIR/status.json.tmp"
  printf '{"status":"%s","finished_at":"%s","host":"%s","backup_dir":"%s","disk_free_bytes":%s,"message":"%s"}\n' \
    "$status" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$(hostname)" \
    "$(json_escape "${DAILY_DIR:-}")" \
    "$(free_bytes 2>/dev/null || echo 0)" \
    "$(json_escape "$message")" >"$tmp"
  mv "$tmp" "$STATUS_FILE"
}

run_alert() {
  local status="$1" summary="$2"
  [ -n "$ALERT_HOOK" ] || return 0
  if [ ! -x "$ALERT_HOOK" ]; then
    warn "ALERT_HOOK 不可执行：$ALERT_HOOK"
    return 1
  fi
  "$ALERT_HOOK" "$status" "$summary" || warn "ALERT_HOOK 执行失败"
}

fail() {
  local message="$1"
  trap - ERR
  warn "$message"
  write_status failure "$message" || true
  run_alert failure "$message" || true
  exit 1
}

cleanup() {
  if [ "$KEEP_DIR" != "1" ] && [ -n "$DAILY_DIR" ] && [ -d "$DAILY_DIR" ]; then
    rm -rf -- "$DAILY_DIR"
  fi
}
trap cleanup EXIT
trap 'fail "意外错误（行 ${LINENO}）"' ERR

prune_dir() {
  local dir="$1" keep="$2"
  local entries=()
  [ -d "$dir" ] || return 0
  mapfile -t entries < <(find "$dir" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | awk '{print $2}')
  local i
  for ((i = keep; i < ${#entries[@]}; i++)); do
    [ -n "${entries[i]}" ] || continue
    log "清理旧备份：${entries[i]}"
    rm -rf -- "${entries[i]}"
  done
}

prune_for_cap() {
  local size
  size="$(scheduled_bytes)"
  [ "$size" -le "$MAX_SCHEDULED_BYTES" ] && return 0
  warn "定时备份 ${size}B 超过上限 ${MAX_SCHEDULED_BYTES}B，清理最旧 daily"
  prune_dir "$BACKUP_ROOT/daily" 1
  size="$(scheduled_bytes)"
  [ "$size" -le "$MAX_SCHEDULED_BYTES" ] ||
    fail "定时备份仍为 ${size}B，超过上限 ${MAX_SCHEDULED_BYTES}B"
}

check_prereqs() {
  [ -d "$APP_DIR" ] || fail "应用目录不存在：$APP_DIR"
  [ -d "$UPLOADS_DIR" ] || fail "上传目录不存在：$UPLOADS_DIR"
  [ -f "$DB_ENV_FILE" ] || fail "数据库环境文件不存在：$DB_ENV_FILE"
  docker inspect -f '{{.State.Running}}' "$DB_CONTAINER" 2>/dev/null | grep -qx true ||
    fail "数据库容器未运行：$DB_CONTAINER"
}

check_disk() {
  local free pct
  free="$(free_bytes)"
  [ "$free" -ge "$MIN_FREE_BYTES" ] ||
    fail "可用空间不足：${free}B < ${MIN_FREE_BYTES}B"
  pct="$(used_pct)"
  if [ "$DRY_RUN" = "1" ]; then
    [ "$pct" -lt "$DISK_WARN_PCT" ] ||
      warn "根分区使用率 ${pct}% ≥ ${DISK_WARN_PCT}%；dry-run 不做清理"
    return 0
  fi
  if [ "$pct" -ge "$DISK_WARN_PCT" ]; then
    warn "根分区使用率 ${pct}% ≥ ${DISK_WARN_PCT}%，先清理最旧定时备份"
    prune_dir "$BACKUP_ROOT/daily" 1
    pct="$(used_pct)"
    [ "$pct" -lt "$DISK_WARN_PCT" ] ||
      fail "磁盘使用率 ${pct}% 仍 ≥ ${DISK_WARN_PCT}%，中止备份"
  fi
  prune_for_cap
}

install -d -m 700 "$STATE_DIR" "$BACKUP_ROOT" "$BACKUP_ROOT/daily" "$BACKUP_ROOT/weekly" "$BACKUP_ROOT/monthly"

check_prereqs
check_disk

if [ "$DRY_RUN" = "1" ]; then
  log "dry-run：配置/路径/容器/磁盘检查通过；备份根目录=$BACKUP_ROOT 可用=$(free_bytes)B"
  exit 0
fi

DAILY_DIR="$BACKUP_ROOT/daily/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DAILY_DIR"
chmod 700 "$DAILY_DIR"

log "开始备份：$DAILY_DIR"

# ---------------------------------------------------------------------------
# 数据库
# ---------------------------------------------------------------------------
set -a
# shellcheck source=/dev/null
. "$DB_ENV_FILE"
set +a
[ -n "${GREATSQL_ROOT_PASSWORD:-}" ] || fail "数据库环境文件缺少 GREATSQL_ROOT_PASSWORD"

DB_ERR="$DAILY_DIR/db.err"
if ! docker exec -e MYSQL_PWD="$GREATSQL_ROOT_PASSWORD" "$DB_CONTAINER" \
  mysqldump -uroot --single-transaction --quick --no-tablespaces --routines --triggers \
  --events --default-character-set=utf8mb4 --set-gtid-purged=OFF "$DB_NAME" \
  2>"$DB_ERR" | gzip -6 >"$DAILY_DIR/db.sql.gz.partial"; then
  fail "mysqldump 失败：$(tail -n 1 "$DB_ERR" 2>/dev/null || echo unknown)"
fi
rm -f "$DB_ERR"
gzip -t "$DAILY_DIR/db.sql.gz.partial" || fail "数据库备份 gzip 校验失败"
DB_TABLES="$(zcat "$DAILY_DIR/db.sql.gz.partial" | grep -c '^CREATE TABLE' || true)"
DB_INSERTS="$(zcat "$DAILY_DIR/db.sql.gz.partial" | grep -c '^INSERT INTO' || true)"
[ "$DB_TABLES" -ge "$MIN_TABLES" ] || fail "数据库备份只有 ${DB_TABLES} 张表，低于 ${MIN_TABLES}"
[ "$DB_INSERTS" -gt 0 ] || fail "数据库备份没有任何 INSERT"
mv "$DAILY_DIR/db.sql.gz.partial" "$DAILY_DIR/db.sql.gz"
DB_BYTES="$(stat -c%s "$DAILY_DIR/db.sql.gz")"
log "数据库备份：${DB_TABLES} 表 / ${DB_INSERTS} INSERT / ${DB_BYTES}B"

# ---------------------------------------------------------------------------
# 上传文件
# ---------------------------------------------------------------------------
UPLOADS_TMP="$DAILY_DIR/uploads.tar.gz.partial"
tar -czf "$UPLOADS_TMP" -C "$(dirname "$UPLOADS_DIR")" "$(basename "$UPLOADS_DIR")" ||
  fail "上传文件打包失败"
tar -tzf "$UPLOADS_TMP" >/dev/null || fail "上传文件包校验失败"
UPLOADS_FILES="$(find "$UPLOADS_DIR" -type f | wc -l)"
mv "$UPLOADS_TMP" "$DAILY_DIR/uploads.tar.gz"
UPLOADS_BYTES="$(stat -c%s "$DAILY_DIR/uploads.tar.gz")"
log "上传文件备份：${UPLOADS_FILES} 个文件 / ${UPLOADS_BYTES}B"

# ---------------------------------------------------------------------------
# 配置（含 .env；备份目录 700，文件 600；不要外发）
# ---------------------------------------------------------------------------
CONFIG_PATHS=()
for path in \
  opt/zafu-pchospital-web/.env \
  opt/zafu-pchospital-db/.env \
  etc/nginx/nginx.conf \
  etc/nginx/sites-available \
  etc/nginx/sites-enabled \
  etc/systemd/system/zafu-pchospital-web.service \
  etc/systemd/system/docs-sync.service \
  etc/systemd/system/docs-sync.timer \
  etc/systemd/system/docs-sync.service.d \
  etc/systemd/system/zafu-backup.service \
  etc/systemd/system/zafu-backup.timer \
  etc/zafu-backup.conf \
  usr/local/bin/docs-sync \
  usr/local/bin/zafu-backup; do
  [ -e "/$path" ] && CONFIG_PATHS+=("$path")
done
[ "${#CONFIG_PATHS[@]}" -gt 0 ] || fail "没有可备份的配置文件"
CONFIG_TMP="$DAILY_DIR/config.tar.gz.partial"
tar -czf "$CONFIG_TMP" -C / "${CONFIG_PATHS[@]}" || fail "配置打包失败"
tar -tzf "$CONFIG_TMP" >/dev/null || fail "配置包校验失败"
mv "$CONFIG_TMP" "$DAILY_DIR/config.tar.gz"
CONFIG_BYTES="$(stat -c%s "$DAILY_DIR/config.tar.gz")"
log "配置备份：${#CONFIG_PATHS[@]} 项 / ${CONFIG_BYTES}B"

# ---------------------------------------------------------------------------
# 清单
# ---------------------------------------------------------------------------
GIT_HEAD="$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
BUILD_ID="$(cat "$APP_DIR/.next/BUILD_ID" 2>/dev/null || echo unknown)"
{
  echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "host=$(hostname)"
  echo "git_head=$GIT_HEAD"
  echo "build_id=$BUILD_ID"
  echo "db_tables=$DB_TABLES"
  echo "db_inserts=$DB_INSERTS"
  echo "db_bytes=$DB_BYTES"
  echo "uploads_files=$UPLOADS_FILES"
  echo "uploads_bytes=$UPLOADS_BYTES"
  echo "config_bytes=$CONFIG_BYTES"
  echo "disk_free_bytes=$(free_bytes)"
  for file in db.sql.gz uploads.tar.gz config.tar.gz; do
    sha256sum "$DAILY_DIR/$file" | awk '{print "sha256_" $2 "=" $1}'
  done
} >"$DAILY_DIR/manifest.txt"
chmod 600 "$DAILY_DIR"/*

# ---------------------------------------------------------------------------
# 周/月副本（硬链接，不重复占空间）
# ---------------------------------------------------------------------------
if [ "$(date +%u)" = "7" ]; then
  WEEK_DIR="$BACKUP_ROOT/weekly/$(date +%G-W%V)"
  if [ ! -e "$WEEK_DIR" ]; then
    install -d -m 700 "$WEEK_DIR"
    cp -al "$DAILY_DIR"/. "$WEEK_DIR"/ || warn "周副本创建失败：$WEEK_DIR"
    log "周副本：$WEEK_DIR"
  fi
fi
if [ "$(date +%d)" = "01" ]; then
  MONTH_DIR="$BACKUP_ROOT/monthly/$(date +%Y-%m)"
  if [ ! -e "$MONTH_DIR" ]; then
    install -d -m 700 "$MONTH_DIR"
    cp -al "$DAILY_DIR"/. "$MONTH_DIR"/ || warn "月副本创建失败：$MONTH_DIR"
    log "月副本：$MONTH_DIR"
  fi
fi

# ---------------------------------------------------------------------------
# 保留与收尾
# ---------------------------------------------------------------------------
KEEP_DIR=1
prune_dir "$BACKUP_ROOT/daily" "$RETENTION_DAILY"
prune_dir "$BACKUP_ROOT/weekly" "$RETENTION_WEEKLY"
prune_dir "$BACKUP_ROOT/monthly" "$RETENTION_MONTHLY"
prune_for_cap

write_status success "backup=$DAILY_DIR"
if [ "$ALERT_ON_SUCCESS" = "1" ]; then
  run_alert success "备份成功：$DAILY_DIR" || true
fi
log "备份完成：$DAILY_DIR（可用空间 $(free_bytes)B）"
