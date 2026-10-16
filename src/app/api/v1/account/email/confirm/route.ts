import { accountEmailRoute } from "@/lib/api/account-email-routes";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return accountEmailRoute(request, "confirm");
}
