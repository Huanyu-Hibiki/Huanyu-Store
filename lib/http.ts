/** 统一错误响应形状 {error: 机器可读码, message: 人类可读说明}，所有 API 路由复用。 */
export function errorResponse(status: number, error: string, message: string): Response {
  return Response.json({ error, message }, { status });
}
