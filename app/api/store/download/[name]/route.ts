import { getCliTokenEmail } from "../../../../../lib/device";
import { bearerToken, errorResponse, siteBase } from "../../../../../lib/http";
import { blobStore } from "../../../../../lib/blob.mjs";
import { resolveDownload, slidingWindowAllow } from "../../../../../lib/download-core.mjs";
import { getSkillReleases, getSkillRoles } from "../../../../../lib/downloads";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;
// 匿名限频共享状态（download-core 注释的 best-effort 语义）：单进程内存窗口，dev/单实例有效。
const hits = new Map<string, number[]>();

/** 免费版下载（任务 6 重定向规则的命门）：无 Authorization 的免费请求 302 → 短时签名 URL
 *  （CLI redirect:'follow'）；带 Authorization 的请求绝不 302（CLI redirect:'error'），有效令牌
 *  200 直出字节 + X-Content-SHA256/X-Skill-Version；付费 402 inactive；未知/无可用版本 404。 */
export async function GET(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  if (!slidingWindowAllow(hits, ip, Date.now()))
    return errorResponse(429, "rate_limited", "下载请求过于频繁，请稍后再试。", NO_STORE);
  const url = new URL(request.url);
  if (url.searchParams.get("format") !== "tar.gz")
    return errorResponse(400, "invalid_format", "format 仅支持 tar.gz。", NO_STORE);
  // 带头即须有效：无效令牌 401（CLI 登录分支），不落入匿名的 302 语义
  const token = bearerToken(request);
  if (token && !(await getCliTokenEmail(token)))
    return errorResponse(401, "unauthorized", "未登录或令牌无效", NO_STORE);
  const [rows, roles] = await Promise.all([getSkillReleases(name), getSkillRoles()]);
  const decision = resolveDownload({ skill: name, version: url.searchParams.get("version") || null, rows, ...roles });
  if (!decision.ok) return errorResponse(decision.status, decision.error, decision.message, NO_STORE);
  const store = blobStore();
  if (token) {
    const bytes = await store.read(decision.row.blob_path);
    return new Response(new Uint8Array(bytes), { headers: {
      "content-type": "application/gzip",
      "x-content-sha256": decision.row.sha256,
      "x-skill-version": decision.row.version,
      ...NO_STORE,
    } });
  }
  const location = await store.signedUrl(decision.row.blob_path, { base: siteBase(request) });
  return new Response(null, { status: 302, headers: { location, ...NO_STORE } });
}
