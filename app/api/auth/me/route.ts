import { isPublisher } from "../../../../lib/device-core.mjs";
import { getCliTokenEmail } from "../../../../lib/device";
import { bearerToken, errorResponse } from "../../../../lib/http";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

/** CLI 契约端点：Bearer 令牌（sha256 查 cli_tokens，未撤销）→
 *  {email, subscriptions: [], publisher}；形状逐字对齐 CLI client.js me() 校验。 */
export async function GET(request: Request) {
  const token = bearerToken(request);
  const email = token ? await getCliTokenEmail(token) : null;
  if (!email) return errorResponse(401, "unauthorized", "未登录或令牌无效", NO_STORE);
  const publisher = isPublisher(email, process.env.PUBLISHER_EMAILS);
  return Response.json({ email, subscriptions: [], publisher }, { headers: NO_STORE });
}
