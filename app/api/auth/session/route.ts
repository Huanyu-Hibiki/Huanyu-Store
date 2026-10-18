import { cookies } from "next/headers";
import { getSessionEmail } from "../../../../lib/auth";
import { SESSION_COOKIE } from "../../../../lib/auth-core.mjs";
import { errorResponse } from "../../../../lib/http";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

/** 会话 hydration：有有效会话返回 {email}，否则 401 统一错误形状；响应不得被中间层缓存。 */
export async function GET() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const email = token ? await getSessionEmail(token) : null;
  if (!email) return errorResponse(401, "unauthorized", "未登录或会话已过期", NO_STORE);
  return Response.json({ email }, { headers: NO_STORE });
}
