import { errorResponse, requirePublisher } from "../../../../../lib/http";
import { upsertProduct } from "../../../../../lib/store";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

/** 商品注册/合并更新（Bearer + publisher 双门槛，鉴权前奏收口 requirePublisher）：
 *  skill 取 URL 规范名；fields 只含调用方提供的键，未提供的键不动；
 *  响应为更新后的完整商品对象（catalog 形状）。 */
export async function PUT(request: Request, { params }: { params: Promise<{ skill: string }> }) {
  const gate = await requirePublisher(request);
  if (gate) return gate;
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
