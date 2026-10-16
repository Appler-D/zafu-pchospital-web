import { accountEmailRoute } from "@/lib/api/account-email-routes";
export const runtime = "nodejs";
export async function GET(request: Request) {
  return accountEmailRoute(request, "state");
}
