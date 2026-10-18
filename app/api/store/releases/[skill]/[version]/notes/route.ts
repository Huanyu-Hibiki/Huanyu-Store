import { getCliTokenEmail } from "../../../../../../../lib/device";
import { isPublisher } from "../../../../../../../lib/device-core.mjs";
import { bearerToken, errorResponse } from "../../../../../../../lib/http";
import { validateNotes } from "../../../../../../../lib/publish-core.mjs";
import { updateReleaseNotes } from "../../../../../../../lib/releases";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

/** notes 修订（Bearer + publisher 双门槛）：body {notes}，规则与 X-Notes 同源（≤2000、
 *  CONTROL 含 bidi 全套拒绝、空串归一 null）；响应 {skill, version, notes}；
 *  未提供 notes 键 → 400；未知版本 → 404。 */
export async function PUT(request: Request, { params }: { params: Promise<{ skill: string; version: string }> }) {
  const token = bearerToken(request);
  const email = token ? await getCliTokenEmail(token) : null;
  if (!email) return errorResponse(401, "unauthorized", "未登录或令牌无效", NO_STORE);
  if (!isPublisher(email, process.env.PUBLISHER_EMAILS)) return errorResponse(403, "not_a_publisher", "没有发布权限。", NO_STORE);
  const { skill, version } = await params;
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null; // 非 JSON 体按缺 notes 键统一拒绝
  }
  if (body === null || typeof body !== "object" || Array.isArray(body) || !("notes" in body))
    return errorResponse(400, "invalid_field", "请求体须为含 notes 字段的 JSON 对象。", NO_STORE);
  const verdict = validateNotes((body as { notes: unknown }).notes);
  if (!verdict.ok) return errorResponse(400, "invalid_field", verdict.message, NO_STORE);
  const updated = await updateReleaseNotes(skill, version, verdict.notes);
  if (!updated) return errorResponse(404, "not_found", "未找到该版本。", NO_STORE);
  return Response.json({ skill, version, notes: verdict.notes }, { headers: NO_STORE });
}
