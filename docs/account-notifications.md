# 报名账号通知运行说明

本功能仅处理本版本上线后，报名审核通过且成功建档的通知。报名邮箱是未验证的通知地址，不改变邮箱身份、门禁、找回资格、邀请码或初始密码政策。缺邮箱的历史记录仍可建档，不推导 QQ 邮箱，也不追溯已有成功账号。

## 状态和人工处理

建档成功与唯一持久化通知任务同事务提交，邮件失败不改变审核 / 建档结果。网页不会启动后台发信。worker 逐批从 GreatSQL 领取，SMTP 在事务外调用；结果回写须匹配领取所有权。

| 状态      | 含义与处理                                                                           |
| --------- | ------------------------------------------------------------------------------------ |
| PENDING   | 待发送，包含邮件关闭 / 等待预算 / 明确暂时拒绝后的等待                               |
| SENDING   | 已领取，两分钟租约内准备并发送；不允许人工开启新轮                                   |
| ACCEPTED  | 已提交发信服务，记录接受时间及可用 Message-ID；不代表送达，不提供补发                |
| FAILED    | 明确永久失败、轮内暂时失败耗尽或资格不符；先处理原因，再由有审核权限的管理员重试通知 |
| UNCERTAIN | 无法确认服务商是否接受或领取超时；停止自动重发，无一键强制补发，请核查服务商记录     |

每轮首次调用 + 三次自动重试最多四次，间隔 1 / 5 / 30 分钟。只有已证明未接受的暂时 SMTP 拒绝可自动重试；超时、socket 错误保持未知。FAILED 人工操作复用原任务，新轮次数归零，累计发送次数和失败审计不清除。处理中重复点击幂等；人工重试不重新审核、建档、重置密码或修改收件地址。

MAIL_ENABLED=false 保留待发任务，不领取、不计发送次数；超时 SENDING 仍会恢复为未知。预算沿用验证码同一个全站每日预算（默认 150）与分钟 10 次桶；额度不足延后到允许窗口，不忙轮询、不退款。仅领取、资格失败或等待额度不计 Sender 次数。

## 凭据和崩溃边界

仅本次真正新建密码凭据的任务可临时生成 #93 初始密码。每次发送前复核当前资格、QQ 归属、凭据代次、mustChangePassword 和哈希匹配；五位老 QQ 规则保持不变。已有账号及已改密 / 重置账号改用无密码模板，密码从不因发信重设。正文只在进程内临时构造，不落任务 / 日志 / 审计 / API。发送前复核不保证邮件到达时密码仍有效，SMTP 期间不阻止用户改密。

未细分领取与开始 SMTP 阶段，因此领取过期全部保守进入 UNCERTAIN，包括实际尚未发送的情况。服务商接受后、写结果前崩溃也只能归未知。实际调用 Sender 后才持久化计数；调用与计数提交之间若进程退出，累计可能少计该次，但任务最终进入未知且不自动重发。此边界不提供 SMTP exactly once / 送达承诺。数据库异常使 CLI 非零退出，不伪装发送成功；下次批次恢复过期领取。

## 运行环境与单批命令

以下为发布负责人执行步骤，本轮仅提供文件，未安装或启动生产服务。

1. 部署完整对应版本源码（包括 `tools/`、Prisma Schema / migrations、配置和 tsconfig），安装锁定 pnpm 依赖、生成 Prisma Client，并先执行本次前向 Migration。只有 `.next` 产物不够运行此 CLI。
2. worker 使用现有应用用户、现有部署目录和受保护环境文件；不新建生产账号。需符合 engines 的 Node，且可解析已锁定的 `tsx`（当前为开发依赖；裁剪为 production-only 依赖时要另行准备完整 worker 运行目录，不能直接省略它）。Nodemailer 已存在，无新运行时依赖。
3. 沿用 DATABASE_URL、AUTH_SECRET、INVITE_CODE_PEPPER、PII_AUDIT_PEPPER 及邮件配置 MAIL_ENABLED / SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD / MAIL_FROM / EMAIL_CODE_PEPPER / EMAIL_DAILY_BUDGET；无需新增环境变量。数据库必须是与网页相同的目标环境。环境文件不得公开或进 Git。
4. 在部署目录可手动运行 `pnpm email:notify --batch=10`（读取 .env），或环境已注入时 `node --import tsx tools/account-notifications.ts --batch=10`。批次缺省 10、上限 50，执行一次即退出；输出只含统计，不含收件人、密码或原始 SMTP 错误。故障查看受控任务状态 / 审计及运维日志，不开启 SMTP 原始 debug。

## systemd 安装示例

确认代码、依赖、生成客户端、Migration 和 SMTP 配置后，复制 `tools/deploy/systemd/pchospital-account-notifications.service` / `.timer` 到 `/etc/systemd/system/`。修改示例 `APPLICATION_USER`、Node 绝对路径、WorkingDirectory 与 EnvironmentFile 为现有部署值。环境文件须符合 systemd EnvironmentFile 语法，通常形如 `KEY=value`，复杂值需按 systemd 引号规则配置，不能依赖 shell 展开。随后由发布负责人执行：

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now pchospital-account-notifications.timer
systemctl list-timers pchospital-account-notifications.timer
systemctl status pchospital-account-notifications.service
journalctl -u pchospital-account-notifications.service
```

timer 每分钟触发；同一 oneshot 尚未完成不会再启动第二份。即便额外手动进程竞争，数据库领取所有权仍保护任务。单批有界，服务超时最多八分钟；租约到期按未知处理，绝不因为重启自动补发可能已提交的邮件。调大批次 / worker 并行不增加共享预算。

## 停用与回退

先 `sudo systemctl disable --now pchospital-account-notifications.timer`，再 `sudo systemctl stop pchospital-account-notifications.service`；确认停止后再回退旧代码。发送中被终止的任务保留，由恢复后的新版本判未知。不要删除任务表、手工清任务或回滚数据库来处理发信失败。MAIL_ENABLED=false 只暂停新的发送，已在途 SMTP 不能撤回。回退保留新增表及数据；旧版本建档没有入队功能，回退期间的新建档不会追溯补发。重新发布时先确认兼容数据 / 配置，再恢复 timer。

真实应用收码仅在用户指定受控账号 / 收件地址并具备配置时做一次。本轮自动验证使用 Fake Sender，未向报名库或生产收件人试发，也不重复 DirectMail DNS / 端口验证。
