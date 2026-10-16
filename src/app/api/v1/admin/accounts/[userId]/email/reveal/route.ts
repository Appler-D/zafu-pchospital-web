import { adminEmailRoute } from "@/lib/api/account-email-routes";
export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ userId: string; id?: string }> },
) {
  const { userId, id } = await context.params;
  return adminEmailRoute(request, "reveal", userId, id);
}
