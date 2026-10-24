# 维修草稿下线：生产存量处置（issue #223）

> 对应 #211 第 4 步。前置：#221 / #222 已部署（生产不再新增 `DRAFT`）。
> 本文是给**负责人**执行的操作手册；AI 不直接操作生产。

## 1. 口径

目标集与处置规则（2026-10-24 确认）：

| 存量记录                                                        | 处置                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------ |
| `DRAFT` + `result = COMPLETED` + 有时长，且补全后能通过提交校验 | 补全可推导字段后**提交**（`PENDING`）                        |
| 其余（结果不是已完成、缺时长、补全后仍校验不过）                | **作废**（软删除）                                           |
| 已撤回草稿（`submittedAt` 非空）                                | dry-run 单列；apply 时必须用 `--submitted=void\|submit` 明确 |

补全只做可推导字段，不伪造数据：

- 机主姓名、电话、机型、维修日期：来自关联报名行 / 活动；只在原值缺失（电话还包括格式不合法）时回填；
- 分类：原分类缺失或已停用 / 删除时，按报名故障类型映射到**启用中的**分类；
- 日期只补空值，不覆盖已有值；已有日期非法（未来 / 超出下限）直接转作废；
- 结果不是「已完成」一律作废，不会把未完成记录改写成已完成。

提交与作废的写入：

- 提交：`status = PENDING`、`submittedAt = 执行时间`、`version + 1`；时间线写 `SUBMITTED`，
  摘要标 `source = draft-retire`；审计 `repair.draft_retired_submitted`（`actorType = SYSTEM`）；
  **不创建审核通知、不写审核结论**，活动登记行保持关联。
- 作废：只写 `deletedAt`（软删除），`status` 仍为 `DRAFT`；时间线写 `DELETED`（含作废原因）；
  审计 `repair.draft_retired_voided`（SYSTEM）；活动登记行保持 `SERVED`，清空 `repair_record_id`，
  看板显示「待补建」，由管理员后续决定补建或撤销接待。不物理删除照片 / 参与人 / 历史。
- 每条记录单独事务、`version` 乐观锁；失败项留在报告里，重跑只处理剩余草稿。

## 2. 执行前检查

1. 确认生产已部署包含 #227（`8d2905a` 或之后）**以及本工具（#223）**的构建；旧版仍会创建草稿，
   旧版也没有 `retire:repair-drafts` 脚本。
2. 观察一段时间，确认没有新增草稿：

   ```bash
   set -a; . /opt/zafu-pchospital-db/.env; set +a
   docker exec -e MYSQL_PWD="$GREATSQL_ROOT_PASSWORD" zafu-pchospital-db-greatsql-1 \
     mysql -uroot zafu_pchospital -e \
     "SELECT COUNT(*) AS d FROM repair_records WHERE status='DRAFT' AND deleted_at IS NULL;"
   ```

3. 做一次**全量数据库备份**（脚本 P4 的备份也可复用；建议再单独留一份）：

   ```bash
   TS=$(date +%Y%m%d-%H%M%S)
   docker exec -e MYSQL_PWD="$GREATSQL_ROOT_PASSWORD" zafu-pchospital-db-greatsql-1 \
     mysqldump -uroot --single-transaction --routines --triggers --events \
     --default-character-set=utf8mb4 zafu_pchospital \
     | gzip -6 > "/opt/zafu-pchospital-backups/draft-retire-$TS.sql.gz"
   ```

4. 在应用目录运行工具（使用应用自己的 `.env`，与线上服务同一数据库）：

   ```bash
   cd /opt/zafu-pchospital-web
   corepack pnpm retire:repair-drafts
   ```

## 3. dry-run（只读）

```bash
cd /opt/zafu-pchospital-web
corepack pnpm retire:repair-drafts --json=/opt/zafu-pchospital-backups/draft-retire-report.json
```

输出按来源（活动接待 / 旧活动键 / 手工）、字段缺失与补全、作废原因、撤回草稿分组计数，
并逐条列出记录 ID 与处置（不打印姓名 / 电话）。`--json` 报告同样不含 PII，可提交给他人复核。

确认：

- 总数与预期一致；
- 「作废原因」中没有可避免的字段缺失；
- 已撤回草稿数量与「可补提 / 不可补提」；
- 需要保留的记录是否都在「补提」组。

## 4. apply（写库）

```bash
cd /opt/zafu-pchospital-web
corepack pnpm retire:repair-drafts \
  --apply \
  --backup-dir=/opt/zafu-pchospital-backups \
  --expect-db=zafu_pchospital \
  --submitted=void
```

- `--backup-dir` 必填：工具会在写库前落一份完整快照
  `<runId>.backup.json`（含机主姓名 / 电话，权限 0600），备份失败不会写库；
- `--expect-db` 必填：与 `DATABASE_URL` 的库名不一致时直接拒绝，避免误连开发 / 测试库；
- `--submitted=void|submit`：存在已撤回草稿时必填；`void` = 作废，`submit` = 补提；
- 执行后会在同目录写 `<runId>.result.json`（runId、逐条结果、事后核对，不含 PII）。

工具最后打印事后核对：

- 可编辑草稿残留必须为 0（作废只做软删除，`deleted_at` 非空的旧 `DRAFT` 行仍保留；
  业务查询均按 `deleted_at IS NULL` 排除，验收计数也按此口径）；
- 补提后 `PENDING` 数 / 作废软删除数 / 接待关联清空数与执行数一致；
- 悬挂登记行（仍指向已删除记录）必须为 0；
- 「待补建接待」是信息项，等于被作废且来自接待的记录数。

任一项不通过时退出码为 1；按失败项处理后**重跑**即可（已处理的记录不会重复处理）。

## 5. 执行后核对

```bash
set -a; . /opt/zafu-pchospital-db/.env; set +a
docker exec -e MYSQL_PWD="$GREATSQL_ROOT_PASSWORD" zafu-pchospital-db-greatsql-1 \
  mysql -uroot zafu_pchospital -e "
SELECT COUNT(*) AS active_drafts FROM repair_records WHERE status='DRAFT' AND deleted_at IS NULL;
SELECT COUNT(*) AS dangling FROM repair_activity_registrations r
  JOIN repair_records x ON x.id = r.repair_record_id WHERE x.deleted_at IS NOT NULL;
SELECT action, COUNT(*) AS n FROM audit_logs
  WHERE action LIKE 'repair.draft_retired_%' GROUP BY action;
SELECT COUNT(*) AS pending_served FROM repair_activity_registrations
  WHERE status='SERVED' AND repair_record_id IS NULL AND deleted_at IS NULL;
"
```

审计查询会按执行批次累计；需要对应单次执行时用 `request_id = <runId>` 过滤。

## 6. 回滚

完整回滚以第 2 步的全量备份为准（停机后还原，避免把执行后的新写入覆盖）：

1. `systemctl stop zafu-pchospital-web`
2. `gunzip -c "/opt/zafu-pchospital-backups/draft-retire-YOUR_TS.sql.gz" | docker exec -i -e MYSQL_PWD="$GREATSQL_ROOT_PASSWORD" zafu-pchospital-db-greatsql-1 mysql -uroot zafu_pchospital`
3. `systemctl start zafu-pchospital-web`

单条回滚（仅应急，时间线 / 审计保留为历史）：

- 作废记录：从 `<runId>.backup.json` 找到原记录，`UPDATE repair_records SET deleted_at=NULL, version=version+1 WHERE id=...`；
  接待关联按备份里的 `repair_activity_registrations.repair_record_id` 恢复；
- 补提记录：按备份恢复 `status / submitted_at / version`（`status='DRAFT'`）。

`<runId>.backup.json` 含个人信息，只留在服务器私有目录；不要提交仓库或粘贴到 Issue / PR。

## 7. 收尾

- 留存：全量 dump、dry-run 报告、`<runId>.backup.json`、`<runId>.result.json`、执行终端输出；
- 清理完成后，再单独评估移除代码中对旧 `DRAFT` 的兼容分支（另开小 PR，不在本工具范围）；
- 若仍有「待补建接待」，由管理员在看板逐条补建或撤销接待，不要再次运行本工具。
