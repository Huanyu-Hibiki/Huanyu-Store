import { blobStore, verifyAttest } from "../../../../lib/blob.mjs";
import { slidingWindowAllow } from "../../../../lib/download-core.mjs";
import { errorResponse } from "../../../../lib/http";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;
// 附件直出端点与下载入口同享匿名限频（security M-1）：签名 URL 虽难猜，字节面也不留无限放大口
const hits = new Map<string, number[]>();

/** 假仓自指回环的附件端点（任务 6）：假存储的「签名 URL」指向这里，302 跟随后拿到 200 字节流。
 *  验证参数 = 对象键形状 + exp 窗口（blob.mjs attestUrl/verifyAttest）。生产关闭镜像 blobStore()
 *  双条件：真仓（302 → presigned）与生产无 token（假仓禁用）都不经此处——一律 404。
 *  全部 404 同文案（security M-1）：不区分「链接无效」与「不存在」，不泄露链接有效性 oracle。 */
export async function GET(request: Request) {
  const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  if (!slidingWindowAllow(hits, ip, Date.now()))
    return errorResponse(429, "rate_limited", "下载请求过于频繁，请稍后再试。", NO_STORE);
  if (process.env.BLOB_READ_WRITE_TOKEN || process.env.NODE_ENV === "production")
    return errorResponse(404, "not_found", "不存在该对象。", NO_STORE);
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (!verifyAttest(key, url.searchParams.get("exp")))
    return errorResponse(404, "not_found", "不存在该对象。", NO_STORE);
  let bytes;
  try { bytes = await blobStore().read(key); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return errorResponse(404, "not_found", "不存在该对象。", NO_STORE);
    throw error;
  }
  return new Response(new Uint8Array(bytes), { headers: { "content-type": "application/gzip", "x-content-type-options": "nosniff", ...NO_STORE } });
}
