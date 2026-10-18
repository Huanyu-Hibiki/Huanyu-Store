import { createDeviceGrant } from "../../../../lib/device";
import { errorResponse, siteBase } from "../../../../lib/http";

export const dynamic = "force-dynamic";

/** 设备码签发。client_name/platform/lang 是 CLI 自述（不落库），未知字段忽略；
 *  响应六字段逐字对齐 CLI auth.js（expires_in/interval 单位秒，CLI 自行 ×1000）。 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { client_name?: unknown; platform?: unknown; lang?: unknown } | null;
  const known = typeof body?.client_name === "string" && body.client_name && typeof body?.platform === "string" && body.platform;
  if (!known || (body?.lang !== undefined && typeof body.lang !== "string")) {
    return errorResponse(400, "invalid_request", "请求参数不合法");
  }
  const grant = await createDeviceGrant();
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
