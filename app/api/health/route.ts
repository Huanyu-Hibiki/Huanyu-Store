import { pingDatabase } from "../../../lib/db";
import { errorResponse } from "../../../lib/http";

export const dynamic = "force-dynamic";

/** 探针：库连通 200；连不通以统一错误形状显式报告 503，不裸抛 500。 */
export async function GET() {
  const ping = await pingDatabase();
  if (!ping.ok) {
    // 驱动错误文本（含主机/端口/用户名）只进服务端日志，响应只给静态文案
    console.error("[health] 数据库探针失败:", ping.reason);
    return errorResponse(503, "database_unavailable", "数据库暂时不可用");
  }
  return Response.json({ status: "ok" });
}
