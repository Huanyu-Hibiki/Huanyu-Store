import { cookies } from "next/headers";
import { revokeSession } from "../../../../lib/auth";
import { SESSION_COOKIE } from "../../../../lib/auth-core.mjs";
import { errorResponse, sameOrigin } from "../../../../lib/http";

export const dynamic = "force-dynamic";

/** 撤销当前会话（按 cookie 令牌哈希）并清 cookie；幂等，无会话也 200。 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return errorResponse(403, "origin_forbidden", "请求来源校验失败");
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await revokeSession(token);
  store.set(SESSION_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
  return Response.json({ ok: true });
}
