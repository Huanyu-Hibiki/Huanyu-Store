import { getCliTokenEmail } from "../../../../../../lib/device";
import { isPublisher } from "../../../../../../lib/device-core.mjs";
import { bearerToken, errorResponse } from "../../../../../../lib/http";
import { yankRelease } from "../../../../../../lib/releases";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

/** 版本下架（Bearer + publisher 双门槛）：置 yanked=true，幂等 200 {skill, version, yanked: true}
 *  （CLI client.unpublish 响应逐字校验）；未知 (skill,version) → 404 统一形状；
 *  孤儿版本同样可下架（不查 catalog）。 */
export async function DELETE(request: Request, { params }: { params: Promise<{ skill: string; version: string }> }) {
  const token = bearerToken(request);
  const email = token ? await getCliTokenEmail(token) : null;
  if (!email) return errorResponse(401, "unauthorized", "未登录或令牌无效", NO_STORE);
  if (!isPublisher(email, process.env.PUBLISHER_EMAILS)) return errorResponse(403, "not_a_publisher", "没有发布权限。", NO_STORE);
  const { skill, version } = await params;
  const yanked = await yankRelease(skill, version);
  if (!yanked) return errorResponse(404, "not_found", "未找到该版本。", NO_STORE);
  return Response.json({ skill, version, yanked: true }, { headers: NO_STORE });
}
