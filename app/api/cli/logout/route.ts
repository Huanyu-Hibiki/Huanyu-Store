import { revokeCliToken } from "../../../../lib/device";
import { bearerToken, errorResponse } from "../../../../lib/http";

export const dynamic = "force-dynamic";

/** 撤销当前 Bearer 令牌：幂等（已撤销仍 200 {revoked:true}）；未知/缺失令牌 401。 */
export async function POST(request: Request) {
  const token = bearerToken(request);
  if (!token || !(await revokeCliToken(token))) return errorResponse(401, "unauthorized", "未登录或令牌无效");
  return Response.json({ revoked: true });
}
