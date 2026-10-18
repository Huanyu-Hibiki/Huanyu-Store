import { listCatalog } from "../../../../lib/store";

export const dynamic = "force-dynamic";

/** 公开目录（无鉴权），固定 {products: [...]} 外层（CLI 容错数组/{products}/{catalog}，服务端取一）。
 *  no-store：hy product 注册后 hy list 必须立即读到新目录，共享缓存会造成旧目录窗口。 */
export async function GET() {
  const products = await listCatalog();
  return Response.json({ products }, { headers: { "cache-control": "no-store" } });
}
