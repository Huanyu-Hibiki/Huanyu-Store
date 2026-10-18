import { getCliTokenEmail } from "../../../../../lib/device";
import { isPublisher } from "../../../../../lib/device-core.mjs";
import { bearerToken, errorResponse } from "../../../../../lib/http";
import { upsertProduct } from "../../../../../lib/store";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

/** 商品注册/合并更新（Bearer + publisher 双门槛）：skill 取 URL 规范名；
 *  fields 只含调用方提供的键，未提供的键不动；响应为更新后的完整商品对象（catalog 形状）。 */
export async function PUT(request: Request, { params }: { params: Promise<{ skill: string }> }) {
  const token = bearerToken(request);
  const email = token ? await getCliTokenEmail(token) : null;
  if (!email) return errorResponse(401, "unauthorized", "未登录或令牌无效", NO_STORE);
  if (!isPublisher(email, process.env.PUBLISHER_EMAILS)) return errorResponse(403, "not_a_publisher", "没有发布权限。", NO_STORE);
  const { skill } = await params;
  let fields: unknown = null;
  try {
    fields = await request.json();
  } catch {
    fields = null; // 非 JSON 体由字段校验统一拒绝
  }
  const result = await upsertProduct(skill, fields);
  if (!result.ok) return errorResponse(400, result.error, result.message, NO_STORE);
  return Response.json(result.product, { headers: NO_STORE });
}
