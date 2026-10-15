---
name: zafu-pchospital-deploy
description: 把 ZAFU-PCHospital/zafu-pchospital-web 部署到生产服务器 pczafu.cn（阿里云 ECS 47.116.132.37）。主流程 = 运行仓库脚本 tools/deploy/deploy-prod.sh（本地构建 + 上传产物；侦察/备份闸门/ff-only/迁移核对/原子切换/冒烟/回滚全内置）。当用户说「部署到服务器」「上线新版」「把 main 发上去」时使用。
---

# 部署 zafu-pchospital-web 到生产

本技能是这套生产环境的**部署操作手册**：任何有服务器 SSH 权限的维护者（及其 AI 助手）都可以按它部署。

**部署统一走仓库脚本 `tools/deploy/deploy-prod.sh`**（本地构建 + 上传产物；侦察、备份闸门、ff-only、
迁移核对、原子切换、冒烟、回滚指引全部内置）：

1. 人在终端运行：`bash tools/deploy/deploy-prod.sh`（脚本自己 `git fetch`；缺省部署 `upstream/main`，
   也可 `--sha <提交>`）。脚本在「开始部署（P2）」与「即将停机（P7）」两处要人工确认 —— **人盯的就是这两个点**。
2. AI 助手在非交互环境运行：必须加 `--yes`（人工确认点自动放行并留痕）——**先取得用户同意**。
   盯脚本输出；失败时按脚本打印的「恢复指引」处理（下面各节就是兜底知识，重跑脚本天然幂等）；
   成功后按第 7 节补做本次改动的针对性验证，并认下结尾的 `DEPLOY RESULT: SUCCESS sha=… build_id=…` 行才算成功。
3. **服务器原地构建已弃用**：生产机只有 1613MB 内存，原地构建曾多次把整机压死（换页占满 2G swap、
   SSH 失联），所以一律「本地构建 + 上传产物」；停机窗口只有「停服务 → 换目录 → 起服务」的秒级。
4. 脚本失败不是终点：它按中断阶段打印具体恢复动作（停机前失败时线上照常；停机后可用
   `--rollback` 秒级回退产物），修好重跑即可继续。

## 0. 事实速查（不要在命令里硬编码密码）

| 项 | 值 |
| --- | --- |
| 公网 | https://pczafu.cn（nginx + certbot，反代 127.0.0.1:3311） |
| 服务器 | 阿里云 ECS `root@47.116.132.37`（Ubuntu）；SSH 私钥向管理员获取，用 `--key` / `DEPLOY_SSH_KEY` 传入，**不要提交进仓库** |
| 应用 | `/opt/zafu-pchospital-web`（仓库检出，属 `zafu-web`，跟踪 `origin/main`） |
| 服务 | systemd `zafu-pchospital-web.service`（`User=zafu-web`，`next start -H 127.0.0.1 -p 3311`，`enabled`） |
| 数据库 | 容器 `zafu-pchospital-db-greatsql-1`（GreatSQL 8.0.32-27），只监听 `127.0.0.1:3307`，库名 `zafu_pchospital` |
| 站内文档 | `/handbook/` 由 nginx 静态服务（不经过 Next）；`docs-sync.timer` 每 30 分钟把文档站产物同步进 `public/handbook`（canonical 脚本 `tools/docs-sync/`） |
| 密钥位置 | 库：`/opt/zafu-pchospital-db/.env`（600，`GREATSQL_ROOT_PASSWORD` / `GREATSQL_APP_PASSWORD`）；应用：`/opt/zafu-pchospital-web/.env`（640 `root:zafu-web`） |
| 服务器运行时 | `node` v22.23.2、`pnpm` 12.4.1、`mdbook` v0.5.4（都在 `/usr/local/bin`） |
| 构建机要求 | Node ≥ 20.19（本仓库 engines）、pnpm（或 `corepack pnpm`）、mdbook v0.5.4、可访问 GitHub 与服务器；本地 `.env`（构建只读，**不连生产库**） |
| 备份 | `/opt/zafu-pchospital-backups/`（700，文件名含提交短 sha）；脚本日志默认 `${TMPDIR:-/tmp}/pczafu-deploy-<时间戳>.log`（运行时会打印路径） |

**任何密钥只从上面两个 `.env` 里 `source` 出来用，不要 echo、不要写进仓库或日志。**

## 1. 开工前判据（脚本已内置闸门；这里是判据与兜底）

1. **不部署未合并的提交**：脚本只接受「已是某个远端 `main` 祖先」的提交，否则直接拒绝。
   先确认目标 PR 已合并、`git fetch` 完成。
2. **迁移闸门**：新增 migration 的 SQL 出现 `DROP / MODIFY / CHANGE / TRUNCATE / UPDATE`
   （`ON UPDATE/DELETE` 外键引用动作除外）时脚本会停 —— 先人工读完整 SQL 确认影响，
   再以 `--allow-risky-migration` 放行。项目规矩：修复必须新增前向 Migration。
3. **环境变量闸门**：`.env.example` 变量行有增减时脚本会停 —— 先把新变量写进服务器
   `/opt/zafu-pchospital-web/.env`，再以 `--allow-env-change` 放行。
4. **停机窗口**：本路线全程停机≈秒级（发生在 P7→P8），但仍要事先和用户约好时间；
   非交互 `--yes` 等于自动确认这两个人工点，**必须用户先同意**。
5. 目标缺省 `upstream/main`；指定提交用 `--sha <sha>`。完整参数见 `bash tools/deploy/deploy-prod.sh --help`。

## 2. 脚本会做什么（P0–P10）

| 阶段 | 内容 | 服务状态 |
| --- | --- | --- |
| P0 | 参数与本地环境预检（pnpm / mdbook / node / ssh / 目标提交已合并） | 正常 |
| P1 | 服务器侦察（只读：HEAD、工作区、服务、内存、磁盘） | 正常 |
| P2 | 变更评估（提交列表 / 迁移风险扫描 / .env.example 变化）+ **人工确认①** | 正常 |
| P3 | 本地构建与打包（独立 worktree，仓库同级的 `.zafu-deploy-build/`，不碰当前工作区；同提交产物复用） | 正常 |
| P4 | 数据库备份 + 闸门（表数 ≥ 27、有 INSERT、gzip 完整） | 正常 |
| P5 | 上传产物并暂存校验（双端 sha256 + 服务器端解包断言） | 正常 |
| P6 | 更新服务器代码（ff-only）与 `.docs-source`、依赖、`pnpm db:generate` | 正常 |
| P7 | **【停机】人工确认②** → 迁移 + seed + 迁移前后全表行数 diff 核对 | **停机** |
| P8 | 原子切换产物（`.next` / `public/handbook`，旧版留 `.next.old`）并启动服务 | 停机→起 |
| P9 | 冒烟验证（见第 7 节）+「新构建 chunk 已生效」校验 | 正常 |
| P10 | 总结与回滚指引；成功输出 `DEPLOY RESULT: SUCCESS sha=… build_id=…` | 正常 |

常用参数：

```text
--sha <sha>       目标提交（缺省 upstream/main，其次 origin/main）
--key <path>      SSH 私钥路径（也可用 DEPLOY_SSH_KEY 环境变量）
--host <user@host>  生产服务器（缺省 root@47.116.132.37）
--yes             非交互：自动放行两个人工确认点（AI / 自动化必须，且需用户同意）
--rollback        只用服务器上的 .next.old 秒级回滚产物（不动数据库与代码）
--rebuild         忽略已有产物缓存强制重建
--redeploy        允许对服务器当前已部署的同一提交重复部署
--allow-risky-migration  已人工读过含 DROP/MODIFY/UPDATE 的迁移 SQL 后放行
--allow-env-change       已确认服务器 .env 随 .env.example 更新后放行
```

## 3. 侦察判据（人工排查时）

```bash
ssh -i "$KEY" root@47.116.132.37 '
  git config --global --add safe.directory /opt/zafu-pchospital-web
  git config --global --add safe.directory /opt/zafu-pchospital-web/.docs-source
  cd /opt/zafu-pchospital-web
  git rev-parse HEAD; git log --oneline -1; git status --porcelain
  systemctl is-active zafu-pchospital-web
  free -m; df -h /opt | tail -1
  docker ps --format "{{.Names}} {{.Status}}"
'
```

- 判据：工作区必须干净（`git status --porcelain` 无输出）。**有未提交改动先停下来问** ——
  那可能是别人正在改的东西，不要 `reset --hard` / `checkout --`。
- **例外（属预期，不是别人的改动）**：`.next.old/`、`.next.bad/`、`public/handbook.old/`、
  `public/handbook.bad/`、`public/handbook.prev/` —— 部署 / 同步留下的回滚副本，看到不用停。

## 4. 备份闸门（脚本 P4 内置；判据备忘）

- **表数 ≥ 27**、**INSERT 行数 > 0**、体积不能只有几十字节（踩过：命令写错又吞了 stderr，
  留下 20 字节的「备份」，而 `gzip -t` 照样通过 —— 所以必须过闸门）。
- `mysqldump: Error: 'Access denied; ... PROCESS privilege ...'` 是**无害警告**（应用账号没有
  PROCESS 权限），不影响数据，别被带偏。
- 备份落 `/opt/zafu-pchospital-backups/zafu_pchospital-<时间戳>-<短sha>.sql.gz`，并写 `LAST_PRE_<短sha>.txt`；
  迁移后脚本会用「迁移前后全表行数 diff」逐项核对。

## 5. 常见中断与恢复

| 中断阶段 | 现象 | 处理 |
| --- | --- | --- |
| P0–P2 | 本地工具缺失 / 目标未合并 / 迁移或 env 闸门 | 修对应问题重跑；**服务器未做任何变更** |
| P3 | 本地构建失败（缺 mdbook / `.docs-source` 太旧 / 日志报错） | 看 `build-<sha>.log` 修好重跑；服务器未动 |
| P4 | 备份闸门未过 | 查 `/opt/zafu-pchospital-backups` 里的 dump 与报错；修好重跑（不动线上数据） |
| P5 | 上传 / 解包校验失败 | 查网络与 `/tmp` 空间；重跑会重传 |
| P6 | 服务器代码 / 依赖更新失败 | 线上仍跑着旧产物；ssh 看 git / pnpm 输出，修好重跑 |
| P7 | 停机后迁移失败 | 服务已停、迁移可能未完成；可先 `systemctl start zafu-pchospital-web` 拉回旧版再排查库 |
| P8 | 切换未完成 / 站点没起来 | `bash tools/deploy/deploy-prod.sh --rollback`；或 ssh 手动换回 |
| P9 | 冒烟失败 | 新版已上线但有问题 → `--rollback`，排查后重来 |
| P10 | 收尾失败 | 不影响站点；重跑或手动清理 |

- 重跑天然幂等；`--rebuild` 强制重建、`--redeploy` 允许重复部署同一提交。
- **服务器连 GitHub 时通时断（GFW）**：脚本 4 次重试失败会**自动改用本地 bundle 传提交**。
  手工兜底：本地 `git branch -f tmp <新sha> && git bundle create pc.bundle tmp --not <旧sha>` →
  scp 上传到服务器 `/tmp` → `git bundle verify` → `git fetch /tmp/pc.bundle refs/heads/tmp` →
  `git merge --ff-only FETCH_HEAD` → `git update-ref refs/remotes/origin/main <新sha>` →
  别忘了 `chown -R zafu-web:zafu-web <改动路径>`。

## 6. 回滚

- **产物（最快，优先用它）**：`bash tools/deploy/deploy-prod.sh --rollback` —— 换回 `.next.old` /
  `public/handbook.old` 并重启，秒级；只动产物，不碰数据库与代码检出。
  （`.next.old` 会保留到下一次部署成功，秒级回滚就靠它。）
- **代码**：ssh 后 `git merge --ff-only <旧 sha>`（旧版本是当前的后代时可行）；不行就
  `git reset --hard <旧 sha>` —— **破坏性操作：先 `git status` 确认无未提交改动，并征得用户同意**。
- **数据库**：`zcat <备份>.sql.gz | docker exec -i zafu-pchospital-db-greatsql-1 mysql -uroot -p"$GREATSQL_ROOT_PASSWORD" zafu_pchospital`。
  前向 migration 不回滚（项目规矩），需要撤只能靠备份还原。

## 7. 部署后验证

脚本 P9 已自动跑冒烟；以下是补充清单。

- 冒烟页面：`/`、`/about`、`/join`、`/docs`、`/repair-activities`、`/robots.txt`、`/sitemap.xml`、
  `/handbook/` 必须 200。文档站注意：`/handbook` 是 **302 → `/handbook/` → 200**（nginx 静态服务）。
  **CI 里没有 nginx、由 Next 自己服务 public 文件，两边表现不同，不要互相套用。**
- 登录态：管理端真实登录一次（账号密码由管理员提供，**不要写进文件**）：

  ```bash
  BASE=https://pczafu.cn
  curl -sS -c pc.cookies -H "Origin: $BASE" -H "Content-Type: application/json" \
    -d '{"qq":"<QQ>","password":"<密码>"}' "$BASE/api/v1/auth/login"
  curl -sS -b pc.cookies -o /dev/null -w "%{http_code}\n" "$BASE/admin"
  ```

  （设 `DEPLOY_SMOKE_QQ` / `DEPLOY_SMOKE_PASSWORD` 可让脚本自动做这一步。）
- 按本次改动补验证：新页面、新 API（**能返回 200 就说明新表真的建出来了**，空表返回 `data:[]`
  也算通过）、菜单入口（点开浮层看条目在不在）。
- 浏览器验证注意（踩过的坑）：**「从未可见」的无头渲染器里，React 流式页面的选择性 hydration
  不会完成** —— `/admin/**` 是全站唯一挂了 `src/app/admin/loading.tsx` 的路由，直接打开会停在骨架；
  **这不是 bug**，从侧栏客户端导航进入即正常。判断 DOM 是否已 hydration：
  `Object.keys(el).some(k=>k.startsWith('__reactFiber$'))`；点击用 `el.click()`；
  React 状态更新是异步的，`click()` 与读取断言要分两次读。截图与断言量按 `AGENTS.md` 第 8 节，别全站重拍。

## 8. 已踩过的坑（部署相关）

1. **`dubious ownership`**：仓库属 `zafu-web` 而命令以 root 跑，git 会拒答（连 `rev-parse` 都失败）——
   两个目录都要 `git config --global --add safe.directory`。
2. **`pnpm install` 会「假装成功」**：lockfile 没变时秒退且**不跑 postinstall**，Prisma Client 会停在旧版
   → 部署必须单独 `pnpm db:generate`。
3. **权限**：root 跑完 git / install / generate 要 `chown -R zafu-web:zafu-web`（`.git`、`node_modules`、`src/generated`）。
4. **`BUILD_ID` 不是构建完成标志**：`next build` 早期就写入它；完成判据看日志出现完整路由表 / `Done in`。
5. **文档站资源名带哈希**（`searchindex-<hash>.js`、`pc-hospital-<hash>.css`）：不要按固定文件名 404 判断文档坏了。
6. **不要在生产造测试数据**：想验证写路径就在本地库做；生产的读写路径用 200 / 空数组 + 表结构核对证明。
7. **迁移一定先读 SQL**：允许的「纯增量」= CREATE / 加索引 / 幂等 INSERT；遇到 DROP / 改列先问。
8. **内存**：生产机 1613MB + 2G swap —— **绝不要在服务器上构建**（旧路线曾四次压死机器）。
9. **`next start` 对静态资源逐请求读盘**：换产物必须「先停服务 → 换目录 → 再起服务」，
   不停服务换目录会出现「内存里旧路由、盘上新文件」的不一致。

## 9. 站内文档与 docs-sync（与部署的交集）

- `/handbook/` = nginx 静态服务 + `docs-sync.timer` 每 30 分钟同步文档站产物；与部署（换
  `public/handbook`）有低概率竞争 —— 部署脚本在停机阶段会自动停该定时器、收尾时恢复，一般不用手工干预。
- 健康判据：`curl -sL https://pczafu.cn/handbook` 200；主题 CSS/JS/searchindex 均可访问。
- 排障：主题资源 404 而文件在磁盘上 = nginx `location ^~ /handbook/` 配置丢失（`nginx -t` 后 reload）；
  改动 nginx 配置前先备份。
