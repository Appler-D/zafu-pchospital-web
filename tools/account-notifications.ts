import { accountNotificationService } from "../src/features/email/account-notification-service";
import { disconnectDb } from "../src/lib/db/client";

/** 有界单批，供人工执行或 systemd timer 每分钟调度；不输出任务 / 邮件 / 凭据内容。 */
async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !/^--batch=\d+$/.test(arg)) || args.length > 1)
    throw new Error("只接受 --batch=1..50");
  const limit = args.length ? Number(args[0].slice("--batch=".length)) : 10;
  const result = await accountNotificationService.runBatch({ limit });
  console.log(JSON.stringify(result));
}
main()
  .catch(() => {
    console.error("账号通知 worker 未完成，请检查数据库与受保护的邮件配置。");
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
