# 管理小鲸鱼部署结果通知

发布仍只走 `bash tools/deploy/deploy-prod.sh`，回滚仍用同一脚本的 `--rollback`。
机器人仅接收固定仓库结果并通知固定管理群 936518691，没有部署、Shell、数据库或网站管理员权限。
此接入没有新增网站 HTTP 接口、运行依赖、Schema 或 Migration。

## 本机配置

安装 Python 3（仅标准库）。私密 JSON 的格式为 `{"url":"https://astrbot.pczafu.cn/integrations/whale-deploy","token":"<私密领取>"}`。
凭证存放在仓库外并限制本机文件权限，不放进 Git、日志、Issue 或群聊。每个维护者私密分发配置或申请独立可撤销 token。

```powershell
$env:WHALE_NOTIFY_CONFIG = '<本机私密 JSON 路径>'
$env:WHALE_NOTIFY_ACTOR = '<维护者称呼>'
# Python 不在 PATH 时：
$env:WHALE_NOTIFY_PYTHON = '<Python 3 可执行文件路径>'
```

Git Bash 同样继承这些变量；Linux/macOS 使用 export。不要开启 Shell xtrace 输出环境或凭证。
通知 CLI 也可用 `--config <路径>`，部署入口通过环境变量读取。未配置时仍保存结果并提示通知失败，不阻断部署。
关闭网络通知设 `WHALE_NOTIFY_DISABLED=1`，本机记录保留；取消该变量后恢复。旧记录不会自动补发。

## 结果、版本与恢复

原 EXIT 钩子覆盖正常收尾与可捕获失败，保留原退出码。新产物将已校验的 BUILD_COMMIT
保存进 `.next/DEPLOY_COMMIT`，随目录切换和回滚一起移动；核对 BUILD_ID、服务存活与内部 HTTP，
成功还须原外部冒烟全过。目标 SHA、服务器 Git HEAD、PR 合并、CI 通过、上传完成均不能替代运行版本。

- `success` / `rollback`：运行 SHA 已核实，冒烟 passed。旧产物缺标记时为 unknown，不能猜测。
- `failed`：构建/备份/上传等明确中断，或冒烟明确失败；仅附已核实的运行 SHA，未知则省略 commit。
- `unknown`：迁移/切换/回滚中断、信号退出或运行版本未确认；短摘要保留阶段、分类、退出码，不上传原始日志、堆栈、环境或备份路径。

每次开始写本机 `attempt-<UUID>.json`；每个终态先保存完整 `<operation_id>.json`，再读凭证、发送一次（超时 12 秒）。
记录目录固定在当前检出根目录 `.runtime/deploy-notifications/`，已忽略。缺 Python 或磁盘不可写会提示，无法保证落盘，部署原退出码仍保留。
失败后另行授权回滚使用新 UUID，摘要关联本检出最近失败的 UUID；不覆盖原结果。跨检出回滚应先核对原记录，在人工摘要中关联原编号。

202 只是持久入队，不代表 QQ 接收、用户送达或已读。查询不重发：

```text
python tools/deploy/notify_deploy.py --check <原UUID>
```

GET 状态为 pending / sending / accepted / rejected / unknown；accepted 仅代表 QQ API 接收。
404 只表示暂未查到，unknown 不自动重发。需要人工核查时保留原 UUID 与 payload，CLI 的
`--payload <原文件>` 只供明确核实后的人工同 ID 同内容操作；不要生成新编号尝试消除超时。
通知错误不能回滚已成功站点，也不能吞掉部署失败。断电、SIGKILL、完全断网只能依赖已有本机记录，
running journal 不是网站状态。没有新增后台自动补发、调度或队列。

## 契约与验证

POST 固定接收端，Bearer 仅在 Header，不跟随重定向；GET 为同一地址加 `/operation_id`。
字段：operation_id（UUID）、固定 repository、status、commit / previous_commit（已核实 SHA）、
smoke（passed / failed / not_run / unknown）、duration_seconds（0–86400）、actor（≤60）、summary（≤240）、dry_run。
success / rollback 必须 commit 且 smoke=passed；JSON ≤4 KiB，不支持任意群或任意原始正文。
同 UUID 同内容只入队一次，不同内容 400；401 认证失败、413 过大、429 限流。没有客户端自动重试。

```text
python -B -m unittest discover -s tests/deploy -v
bash -n tools/deploy/deploy-prod.sh
bash -n tools/deploy/notify-result.sh
```

`tests/deploy/` 还包含本地替身部署流程测试：不连生产、不访问网络，覆盖网络失败切 bundle、
纯代码跳过数据库阶段、历史待应用迁移、schema 无迁移中止、失败退出码、docs-sync 定时器恢复
与通知记录隔离。CI 会执行 `bash -n` 与上述 unittest，无需在有生产凭据的环境运行。

本地替身验证实际 EXIT 钩子的成功、构建/上传/迁移/切换/冒烟失败、回滚以及通知超时隔离。
公网只允许负责人授权的一次 `--dry-run` 契约校验（200，不入队、不发群），不能发“测试部署成功”。
真实群投递由下一次另行授权的真实部署验证，不是本任务的发布授权。
