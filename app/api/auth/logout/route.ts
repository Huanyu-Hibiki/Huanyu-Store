import { cookies } from "next/headers";
import { revokeSession } from "../../../../lib/auth";
import { SESSION_COOKIE } from "../../../../lib/auth-core.mjs";

export const dynamic = "force-dynamic";

/** 撤销当前会话（按 cookie 令牌哈希）并清 cookie；幂等，无会话也 200。 */
export async function POST() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await revokeSession(token);
  store.set(SESSION_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
  return Response.json({ ok: true });
}
