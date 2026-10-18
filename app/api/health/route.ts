import { pingDatabase } from "../../../lib/db";
import { errorResponse } from "../../../lib/http";

export const dynamic = "force-dynamic";

/** 探针：库连通 200；连不通以统一错误形状显式报告 503，不裸抛 500。 */
export async function GET() {
  const ping = await pingDatabase();
  if (!ping.ok) return errorResponse(503, "database_unavailable", ping.reason);
  return Response.json({ status: "ok" });
}
