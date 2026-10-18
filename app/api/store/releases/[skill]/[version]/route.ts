import { earlyResponse, requirePublisher } from "../../../../../../lib/http";
import { isVersion } from "../../../../../../lib/publish-core.mjs";
import { isCanonicalSkillName } from "../../../../../../lib/store-core.mjs";
import { yankRelease } from "../../../../../../lib/releases";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

/** 版本下架（Bearer + publisher 双门槛）：置 yanked=true，幂等 200 {skill, version, yanked: true}
 *  （CLI client.unpublish 响应逐字校验）；skill/version 形状预检非法与未知均 404 统一形状
 *  （预检省一次 DB 往返，security L-6）；孤儿版本同样可下架（不查 catalog）。 */
export async function DELETE(request: Request, { params }: { params: Promise<{ skill: string; version: string }> }) {
  const gate = await requirePublisher(request);
  if (gate) return gate;
  const { skill, version } = await params;
  if (!isCanonicalSkillName(skill) || !isVersion(version))
    return earlyResponse(request, 404, "not_found", "未找到该版本。");
  const yanked = await yankRelease(skill, version);
  if (!yanked) return earlyResponse(request, 404, "not_found", "未找到该版本。");
  return Response.json({ skill, version, yanked: true }, { headers: NO_STORE });
}
