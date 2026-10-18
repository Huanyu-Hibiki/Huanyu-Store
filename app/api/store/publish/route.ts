import { getCliTokenEmail } from "../../../../lib/device";
import { isPublisher } from "../../../../lib/device-core.mjs";
import { bearerToken, errorResponse, siteBase } from "../../../../lib/http";
import { blobStore } from "../../../../lib/blob.mjs";
import { MAX_PACKAGE_BYTES, downloadUrlFor, drainBody, readPackageBody, validatePublishHeaders } from "../../../../lib/publish-core.mjs";
import { storeRelease } from "../../../../lib/releases";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

/** 版本发布（Bearer + publisher 双门槛），体 = tar.gz 二进制，管道便宜检查在前：
 *  鉴权 → 头形状（400 invalid_package）→ Content-Length 早退（413 too_large）→ 流式魔数/累计字节/
 *  sha256（400/413）→ 事务（advisory 锁 + 409 族 + Blob 私有落仓 + 插 releases）。
 *  响应五字段逐字过 CLI client.publish 校验（size = 实际收到字节数）。 */
export async function POST(request: Request) {
  // 早退统一先清空请求体（无体请求自然跳过）：未消费完就回响应会毒化 keep-alive 连接，
  // 后继复用该连接的请求悬挂到超时（publish-core「早退必须先清空」不变式，quality M1/security L-3）
  const reject = async (status: number, error: string, message: string) => {
    if (request.body) await drainBody(request.body);
    return errorResponse(status, error, message, NO_STORE);
  };

  const token = bearerToken(request);
  const email = token ? await getCliTokenEmail(token) : null;
  if (!email) return reject(401, "unauthorized", "未登录或令牌无效");
  if (!isPublisher(email, process.env.PUBLISHER_EMAILS)) return reject(403, "not_a_publisher", "没有发布权限。");

  const header = validatePublishHeaders({
    name: request.headers.get("x-skill-name"),
    version: request.headers.get("x-skill-version"),
    sha256: request.headers.get("x-content-sha256"),
    notes: request.headers.get("x-notes"),
  });
  if (!header.ok) return reject(400, "invalid_package", header.message);

  // 分块上传无 Content-Length，此处只是早退；真正的裁决在读体的累计字节数
  const declared = Number(request.headers.get("content-length"));
  if (Number.isSafeInteger(declared) && declared > MAX_PACKAGE_BYTES)
    return reject(413, "too_large", "包超过 4MB 上限。");

  if (!request.body) return errorResponse(400, "invalid_package", "缺少上传内容。", NO_STORE);
  const read = await readPackageBody(request.body);
  if (!read.ok) return errorResponse(read.error === "too_large" ? 413 : 400, read.error, read.message, NO_STORE);
  if (read.sha256 !== header.sha256)
    return errorResponse(400, "invalid_package", "内容摘要与 X-Content-SHA256 头不一致。", NO_STORE);

  // 事务内：advisory 锁串行化同 skill 并发（低版本穿窗拒）→ 409 族 → Blob → 插库；
  // Blob 写失败异常上抛 500 不落库（孤儿 blob 无害，随机后缀路径不可发现）
  const stored = await storeRelease({
    skill: header.name, version: header.version, sha256: read.sha256,
    size: read.bytes.length, notes: header.notes, bytes: read.bytes,
    write: (skill, version, bytes) => blobStore().put(skill, version, bytes),
  });
  if (!stored.ok) return errorResponse(409, stored.error, stored.message, NO_STORE);

  return Response.json(
    { skill: header.name, version: header.version, sha256: read.sha256, size: read.bytes.length, url: downloadUrlFor(siteBase(request), header.name, header.version) },
    { headers: NO_STORE },
  );
}
