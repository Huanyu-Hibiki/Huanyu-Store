import { cookies } from "next/headers";
import { getSessionEmail } from "../../../../lib/auth";
import { SESSION_COOKIE } from "../../../../lib/auth-core.mjs";
import { normalizeUserCode } from "../../../../lib/device-core.mjs";
import { decideDeviceGrant } from "../../../../lib/device";
import { errorResponse, sameOrigin } from "../../../../lib/http";

export const dynamic = "force-dynamic";

/** 设备授权确认（浏览器专用）：Web 会话 + 同源双门槛；
 *  user_code 未知/过期/已判定统一模糊 404，不泄露 grant 状态。 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return errorResponse(403, "origin_forbidden", "请求来源校验失败");
  const store = await cookies();
  const sessionToken = store.get(SESSION_COOKIE)?.value;
  const email = sessionToken ? await getSessionEmail(sessionToken) : null;
  if (!email) return errorResponse(401, "unauthorized", "未登录或会话已过期");
  const body = (await request.json().catch(() => null)) as { user_code?: unknown; approve?: unknown } | null;
  const userCode = typeof body?.user_code === "string" ? normalizeUserCode(body.user_code) : null;
  if (!userCode || typeof body?.approve !== "boolean") return errorResponse(400, "invalid_user_code", "设备码格式不正确");
  const result = await decideDeviceGrant(userCode, body.approve, email);
  if (!result.ok) return errorResponse(404, "not_found", "设备码不存在或已过期");
  return Response.json({ status: result.status });
}
