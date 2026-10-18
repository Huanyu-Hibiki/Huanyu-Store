import { pollDeviceToken, type PollError } from "../../../../lib/device";
import { errorResponse } from "../../../../lib/http";

export const dynamic = "force-dynamic";

const MESSAGES: Record<PollError, string> = {
  authorization_pending: "等待用户在浏览器确认授权",
  slow_down: "轮询过于频繁，请放慢间隔",
  access_denied: "用户拒绝了本次授权",
  expired_token: "设备码不存在或已过期",
};

/** CLI 轮询换令牌：错误族四码（CLI auth.js 逐字匹配）只走 400；成功 {token, email}。 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { device_code?: unknown } | null;
  const deviceCode = typeof body?.device_code === "string" ? body.device_code : "";
  if (!deviceCode) return errorResponse(400, "invalid_request", "请求参数不合法");
  const result = await pollDeviceToken(deviceCode);
  if (!result.ok) return errorResponse(400, result.error, MESSAGES[result.error]);
  return Response.json({ token: result.token, email: result.email });
}
