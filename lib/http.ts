/** 统一错误响应形状 {error: 机器可读码, message: 人类可读说明}，所有 API 路由复用；headers 可选（如 no-store）。 */
export function errorResponse(status: number, error: string, message: string, headers?: Record<string, string>): Response {
  return Response.json({ error, message }, { status, headers });
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
