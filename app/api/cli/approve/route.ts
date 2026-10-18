import { cookies } from "next/headers";
import { getSessionEmail } from "../../../../lib/auth";
import { SESSION_COOKIE } from "../../../../lib/auth-core.mjs";
import { normalizeUserCode } from "../../../../lib/device-core.mjs";
import { decideDeviceGrant, getGrantClientInfo } from "../../../../lib/device";
import { errorResponse, sameOrigin } from "../../../../lib/http";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

/** 确认卡的申请方回显：?code=<user_code> → pending grant 的 CLI 自述（非机密，见 getGrantClientInfo）；
 *  未知/过期统一模糊 404。GET 非状态变更，不设 Origin 门槛。 */
export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("code");
  const userCode = raw ? normalizeUserCode(raw) : null;
  if (!userCode) return errorResponse(404, "not_found", "设备码不存在或已过期", NO_STORE);
  const info = await getGrantClientInfo(userCode);
  if (!info) return errorResponse(404, "not_found", "设备码不存在或已过期", NO_STORE);
  return Response.json(info, { headers: NO_STORE });
}

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
