#!/usr/bin/env bash
#
# 站内文档同步：ZAFU-PCHospital-Doc 的 gh-pages 产物 → 生产的 public/handbook。
#
# 由 docs-sync.timer 每 30 分钟调用（也可手工执行，幂等）：
#   1. 比对 gh-pages SHA 与产物里的 revision 标记；无变化也检查实际 HTTP 资源与官网定制；
#   2. 按 SHA 下载，校验源码与实际产物主题，复用官网定制处理；
#   3. 探测新文件可访问后替换目录，写入 revision 标记，HTTP 验证通过才记录 SHA；失败回滚。
#
# 只碰 public/handbook：不重建站点、不重启服务、不动数据库、不动 .docs-source。
# 必须由 nginx 直接服务 /handbook/，见 nginx-handbook.conf；不依赖 Next 静态清单。
# 以 zafu-web 身份运行；staging 在 public 下，目录 rename 不跨文件系统。
#
# 回滚：mv public/handbook public/handbook.bad && mv public/handbook.prev public/handbook
# 手工补跑：systemctl start docs-sync.service && journalctl -u docs-sync -n 50 --no-pager
#
set -euo pipefail

DOCS_REPO="ZAFU-PCHospital/ZAFU-PCHospital-Doc"
DOCS_BRANCH="gh-pages"
DOCS_SOURCE_REF="main" # 一致性校验比对的是文档仓库 main 的源码
# 生产路径；演练时可用 DOCS_SYNC_APP_DIR / DOCS_SYNC_STATE_DIR 指向临时目录，
# 行为与生产完全一致而不碰线上文件。
APP_DIR="${DOCS_SYNC_APP_DIR:-/opt/zafu-pchospital-web}"
TOOLS_DIR="${DOCS_SYNC_TOOLS_DIR:-${APP_DIR}}"
DEST="${APP_DIR}/public/handbook"
PREV="${APP_DIR}/public/handbook.prev"
STAGE="${APP_DIR}/public/.handbook.stage"
STATE_DIR="${DOCS_SYNC_STATE_DIR:-/var/lib/docs-sync}"
SHA_FILE="${STATE_DIR}/deployed-sha"
BASE_URL="${DOCS_SYNC_BASE_URL:-https://pczafu.cn/handbook/}"
helper="${TOOLS_DIR}/tools/handbook.mjs"
# 部署产物里也写一份 revision：只靠 deployed-sha 无法发现“目录被别的部署换成旧版”。
REVISION_FILE="${DEST}/.pc-hospital-docs-revision"

log() { echo "[docs-sync] $*"; }
warn() { echo "[docs-sync] $*" >&2; }
die() {
  echo "[docs-sync] 失败：$*" >&2
  exit 1
}

mkdir -p "$STATE_DIR"
for command in node git curl tar flock timeout; do
  command -v "$command" >/dev/null || die "缺少同步命令：${command}"
done
[ -f "$helper" ] || die "找不到 ${helper}，请同步安装官网 tools/ 下的配套文件"

# 单实例：手工执行与 timer 撞车时直接退出，不排队
exec 9>"${STATE_DIR}/.lock"
flock -n 9 || {
  log "已有实例在运行，退出"
  exit 0
}

# 服务器到 GitHub 的连通性时好时坏（实测过挂起与超时），所以取 sha 要重试；
# 内部日志走 stderr，别把 stdout 的 sha 污染了。
fetch_remote_sha() {
  local attempt sha
  for attempt in 1 2 3 4 5; do
    sha="$(timeout 45 git ls-remote "https://github.com/${DOCS_REPO}.git" "refs/heads/${DOCS_BRANCH}" 2>/dev/null | cut -f1)"
    if [ -n "$sha" ]; then
      echo "$sha"
      return 0
    fi
    warn "第 ${attempt}/5 次取 ${DOCS_BRANCH} 的 sha 失败（外网抖动），10 秒后重试"
    sleep 10
  done
  return 1
}

remote_sha="$(fetch_remote_sha)" || die "连续 5 次取不到 ${DOCS_BRANCH} 的 sha，等下一次定时再试"
[[ "$remote_sha" =~ ^[0-9a-f]{40}$ ]] || die "远端 SHA 格式无效：${remote_sha}"

deployed_sha="$(cat "$SHA_FILE" 2>/dev/null || true)"
deployed_revision="$(cat "$REVISION_FILE" 2>/dev/null || true)"
if [ "${remote_sha}" = "${deployed_sha}" ]; then
  if [ "${deployed_revision}" = "${remote_sha}" ] && node "$helper" verify "$DEST" "$BASE_URL"; then
    log "无变化且内容标记/HTTP 校验通过（${remote_sha:0:12}），退出"
    exit 0
  fi
  warn "SHA 无变化但内容标记或 HTTP 校验不一致，重新同步修复"
fi
log "检测到更新：${deployed_sha:0:12} → ${remote_sha:0:12}"

work="$(mktemp -d /tmp/docs-sync.XXXXXX)"
trap 'rm -rf "${work}"' EXIT

curl -fsSL --connect-timeout 15 --max-time 600 --retry 3 --retry-delay 5 --retry-connrefused \
  "https://codeload.github.com/${DOCS_REPO}/tar.gz/${remote_sha}" \
  -o "${work}/book.tar.gz" || die "下载失败（外网不稳，等下次定时再试）"

mkdir -p "${work}/unpack"
tar -xzf "${work}/book.tar.gz" -C "${work}/unpack" || die "解包失败"
src="$(find "${work}/unpack" -mindepth 1 -maxdepth 1 -type d | head -1)"
[ -n "${src}" ] || die "tarball 里没有目录"

# 产物完整性：缺一即中止，线上一个字节都不动
[ -f "${src}/index.html" ] || die "产物缺少 index.html"
find "${src}" -maxdepth 1 -name 'searchindex*.js' -print -quit | grep -q . || die "产物缺少 searchindex"
theme_css="$(node "$helper" prepare "$src")" || die "文档产物引用不完整或官网定制失败"

# 主题与 mdBook 配置闸门：与 pnpm lint 用同一份校验器，比对文档仓库 main 的源码
# （theme/pc-hospital.css + book.toml）是否与官网令牌/模式映射一致。
# 注意：raw.githubusercontent.com 在国内常被墙，这里统一走 codeload（实测可达且很快）。
curl -fsSL --connect-timeout 15 --max-time 300 --retry 3 --retry-delay 5 --retry-connrefused \
  "https://codeload.github.com/${DOCS_REPO}/tar.gz/refs/heads/${DOCS_SOURCE_REF}" \
  -o "${work}/source.tar.gz" || die "下载文档源码失败，无法校验一致性（宁可不同步，也不上线没校验的内容）"
mkdir -p "${work}/source"
tar -xzf "${work}/source.tar.gz" -C "${work}/source" || die "文档源码解包失败"
docs_src="$(find "${work}/source" -mindepth 1 -maxdepth 1 -type d | head -1)"
[ -f "${docs_src}/book.toml" ] || die "文档源码缺少 book.toml"
[ -f "${docs_src}/theme/pc-hospital.css" ] || die "文档源码缺少主题 CSS"
checker="${TOOLS_DIR}/tools/check-theme-palette.mjs"
[ -f "${checker}" ] || die "找不到校验器 ${checker}（演练时请把 DOCS_SYNC_TOOLS_DIR 指向站点目录）"
DOCS_SOURCE_DIR="${docs_src}" node "${checker}" ||
  die "主题或 mdBook 配置与官网不一致，拒绝替换（文档仓库改了配色但没同步官网？）"
DOCS_SOURCE_DIR="${docs_src}" DOCS_THEME_CSS="${theme_css}" node "${checker}" ||
  die "实际发布的主题与官网不一致，拒绝替换"
log "源码配置与实际产物主题校验通过"

# gh-pages 是给 GitHub Pages 用的，这两个文件不属于站内文档
rm -f "${src}/CNAME" "${src}/.nojekyll"

# 发布前探测：Next.js 生产模式无法识别启动后新增的 public 文件。
node "$helper" probe "$DEST" "$BASE_URL" ||
  die "新文件不能立即通过 HTTP 访问；请先应用 nginx-handbook.conf，现有文档未替换"

# 在目标文件系统内 staging；两次 rename 之间有极短的目录缺口。
rm -rf "$STAGE"
cp -a "$src" "$STAGE"
printf '%s\n' "$remote_sha" >"${STAGE}/.pc-hospital-docs-revision"
rm -rf "$PREV"
if [ -d "$DEST" ]; then mv "$DEST" "$PREV"; fi
if ! mv "$STAGE" "$DEST"; then
  if [ -d "$PREV" ]; then mv "$PREV" "$DEST"; fi
  die "目录替换失败，已尝试恢复上一版"
fi

if ! node "$helper" verify "$DEST" "$BASE_URL"; then
  # STAGE 暂存失败版本，避免直接删除用于恢复的目录。
  mv "$DEST" "$STAGE"
  if [ -d "$PREV" ]; then mv "$PREV" "$DEST"; fi
  rm -rf "$STAGE"
  die "发布后 HTTP 校验失败，已回滚；未记录本次 SHA"
fi

echo "$remote_sha" >"${SHA_FILE}.tmp"
mv "${SHA_FILE}.tmp" "$SHA_FILE"
log "已部署 ${remote_sha:0:12}，上一版保留在 ${PREV}"
