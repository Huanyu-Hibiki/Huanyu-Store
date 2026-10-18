import { getCliTokenEmail } from "./device";
import { isPublisher } from "./device-core.mjs";
import { drainBody } from "./publish-core.mjs";

/** 统一错误响应形状 {error: 机器可读码, message: 人类可读说明}，所有 API 路由复用；headers 可选（如 no-store）。 */
export function errorResponse(status: number, error: string, message: string, headers?: Record<string, string>): Response {
  return Response.json({ error, message }, { status, headers });
}

/** 写路由早退响应（任务 5 不变式「早退必须先清空」的收口助手）：未消费的请求体有界丢弃
 *  （不消费完就回响应会毒化 keep-alive 连接）；已被 json() 等消费过的自然跳过（再读会抛错）。 */
export async function earlyResponse(request: Request, status: number, error: string, message: string): Promise<Response> {
  if (request.body && !request.bodyUsed) await drainBody(request.body).catch(() => {});
  return errorResponse(status, error, message, { "cache-control": "no-store" });
}

/** 写路由（publish/products/releases）共用鉴权前奏：Bearer + publisher 双门槛（quality LOW
 *  收口四处重复）；401/403 早退统一走 earlyResponse（先清空体再回）。通过返回 null。 */
export async function requirePublisher(request: Request): Promise<Response | null> {
  const token = bearerToken(request);
  const email = token ? await getCliTokenEmail(token) : null;
  if (!email) return earlyResponse(request, 401, "unauthorized", "未登录或令牌无效");
  if (!isPublisher(email, process.env.PUBLISHER_EMAILS)) return earlyResponse(request, 403, "not_a_publisher", "没有发布权限。");
  return null;
}

/** CSRF 纵深：浏览器专用端点的 Origin 校验——Origin 缺失或与请求主机不一致一律拒。
 *  比对基准是 Host 头（有 x-forwarded-host 时优先，反代/平台控制，不可伪造）；不用 request.url，
 *  dev 下其 host 固定为 localhost 与实际绑定地址不一致。任务 3 的 /api/cli/approve 等直接复用。 */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** 站点基址（协议+主机，无路径）：配置了 SITE_ORIGIN（security L-1 规范源）就一律用它——
 *  请求头可被客户端伪造或被代理链污染，下发 URL（download_url 等）以部署声明的源为准，尾部斜杠归一；
 *  未配置回落 x-forwarded-* 与 Host 头（本地开发），反代链可能给逗号列表，取第一个。
 *  与 sameOrigin 同理不信任 request.url。 */
export function siteBase(request: Request): string {
  const configured = process.env.SITE_ORIGIN;
  if (configured) return configured.replace(/\/+$/, "");
  const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "").split(",")[0].trim();
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0].trim() || "http";
  return `${proto}://${host}`;
}

/** Authorization: Bearer <token> 解析；缺失或非 Bearer 方案返回 null。 */
export function bearerToken(request: Request): string | null {
  const match = request.headers.get("authorization")?.match(/^Bearer (.+)$/);
  const token = match ? match[1].trim() : "";
  return token || null;
}
