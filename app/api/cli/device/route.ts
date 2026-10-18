import { normalizeIp } from "../../../../lib/auth-core.mjs";
import { CLIENT_INFO_MAX_LENGTH } from "../../../../lib/device-core.mjs";
import { createDeviceGrant } from "../../../../lib/device";
import { errorResponse, siteBase } from "../../../../lib/http";

export const dynamic = "force-dynamic";

// 信任边界：Vercel 平台覆写 x-forwarded-for（不可伪造）；自托管部署须由反代保证同语义
const clientIp = (request: Request) =>
  normalizeIp(request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown");

/** 设备码签发。client_name/platform 是 CLI 自述（≤128，非机密，确认页回显防钓鱼），未知字段忽略；
 *  响应六字段逐字对齐 CLI auth.js（expires_in/interval 单位秒，CLI 自行 ×1000）。
 *  限频即封顶攻击面：token 轮询的昂贵路径（事务）必须持有效 grant，随机码盲打只命中主键单查早退；
 *  无限签发才是唯一的行写入放大入口——每 IP 10 次/小时 + 全局日预算卡死它。 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { client_name?: unknown; platform?: unknown; lang?: unknown } | null;
  const name = typeof body?.client_name === "string" ? body.client_name : "";
  const platform = typeof body?.platform === "string" ? body.platform : "";
  const known = name && platform && name.length <= CLIENT_INFO_MAX_LENGTH && platform.length <= CLIENT_INFO_MAX_LENGTH;
  if (!known || (body?.lang !== undefined && typeof body.lang !== "string")) {
    return errorResponse(400, "invalid_request", "请求参数不合法");
  }
  const grant = await createDeviceGrant({ ip: clientIp(request), clientName: name, platform });
  if (!grant.ok) return errorResponse(429, "rate_limited", "设备码请求过于频繁，请稍后再试");
  const base = siteBase(request);
  return Response.json({
    device_code: grant.device_code,
    user_code: grant.user_code,
    verification_uri: `${base}/cli`,
    verification_uri_complete: `${base}/cli?code=${encodeURIComponent(grant.user_code)}`,
    expires_in: grant.expires_in,
    interval: grant.interval,
  });
}
