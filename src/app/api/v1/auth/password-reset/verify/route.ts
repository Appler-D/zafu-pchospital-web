import { passwordRecoveryRoute } from "@/lib/api/password-recovery-routes";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return passwordRecoveryRoute(request, "verify");
}
