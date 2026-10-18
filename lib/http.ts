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
