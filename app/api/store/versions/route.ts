import { siteBase } from "../../../../lib/http";
import { downloadUrlFor } from "../../../../lib/publish-core.mjs";
import { listVersions } from "../../../../lib/releases";

export const dynamic = "force-dynamic";

/** 公开版本表（无鉴权）：{skills: {name: {latest, history, sha256, download_url}}}。
 *  孤儿版本可见（CLI product 预检 known 依赖）；catalog 未发布名字占位；
 *  no-store：publish/product 之后 CLI 立即读版本表，不得走共享缓存。 */
export async function GET(request: Request) {
  const { skills } = await listVersions((skill, version) => downloadUrlFor(siteBase(request), skill, version));
  return Response.json({ skills }, { headers: { "cache-control": "no-store" } });
}
