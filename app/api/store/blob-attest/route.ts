import { blobStore, verifyAttest } from "../../../../lib/blob.mjs";
import { errorResponse } from "../../../../lib/http";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

/** 假仓自指回环的附件端点（任务 6）：假存储的「签名 URL」指向这里，302 跟随后拿到 200 字节流。
 *  验证参数 = 对象键形状 + exp 窗口（blob.mjs attestUrl/verifyAttest）；真仓配了
 *  BLOB_READ_WRITE_TOKEN 时永不签发 attest URL，此路由直接 404 关闭。 */
export async function GET(request: Request) {
  if (process.env.BLOB_READ_WRITE_TOKEN)
    return errorResponse(404, "not_found", "不存在该对象。", NO_STORE);
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (!verifyAttest(key, url.searchParams.get("exp")))
    return errorResponse(404, "not_found", "链接无效或已过期。", NO_STORE);
  let bytes;
  try { bytes = await blobStore().read(key); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return errorResponse(404, "not_found", "不存在该对象。", NO_STORE);
    throw error;
  }
  return new Response(new Uint8Array(bytes), { headers: { "content-type": "application/gzip", ...NO_STORE } });
}
