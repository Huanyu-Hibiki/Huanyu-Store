import { getCliTokenEmail } from "../../../../lib/device";
import { isPublisher } from "../../../../lib/device-core.mjs";
import { bearerToken, errorResponse, siteBase } from "../../../../lib/http";
import { blobStore } from "../../../../lib/blob.mjs";
import { MAX_PACKAGE_BYTES, downloadUrlFor, drainBody, readPackageBody, validatePublishHeaders } from "../../../../lib/publish-core.mjs";
import { checkReleaseVersion, insertRelease } from "../../../../lib/releases";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

/** 版本发布（Bearer + publisher 双门槛），体 = tar.gz 二进制，管道便宜检查在前：
 *  鉴权 → 头形状（400 invalid_package）→ Content-Length 早退（413 too_large）→ 流式魔数/累计字节/
 *  sha256（400/413）→ 版本单调性（409 族）→ Blob 私有落仓 → 插 releases（主键竞态兜底 409）。
 *  响应五字段逐字过 CLI client.publish 校验（size = 实际收到字节数）。 */
export async function POST(request: Request) {
  const token = bearerToken(request);
  const email = token ? await getCliTokenEmail(token) : null;
  if (!email) return errorResponse(401, "unauthorized", "未登录或令牌无效", NO_STORE);
  if (!isPublisher(email, process.env.PUBLISHER_EMAILS)) return errorResponse(403, "not_a_publisher", "没有发布权限。", NO_STORE);

  const header = validatePublishHeaders({
    name: request.headers.get("x-skill-name"),
    version: request.headers.get("x-skill-version"),
    sha256: request.headers.get("x-content-sha256"),
    notes: request.headers.get("x-notes"),
  });
  if (!header.ok) return errorResponse(400, "invalid_package", header.message, NO_STORE);

  // 分块上传无 Content-Length，此处只是早退；真正的裁决在读体的累计字节数。
  // 先清空体再回：未消费完的请求体会毒化 keep-alive 连接（后继请求悬挂到超时）
  const declared = Number(request.headers.get("content-length"));
  if (Number.isSafeInteger(declared) && declared > MAX_PACKAGE_BYTES) {
    if (request.body) await drainBody(request.body);
    return errorResponse(413, "too_large", "包超过 4MB 上限。", NO_STORE);
  }

  if (!request.body) return errorResponse(400, "invalid_package", "缺少上传内容。", NO_STORE);
  const read = await readPackageBody(request.body);
  if (!read.ok) return errorResponse(read.error === "too_large" ? 413 : 400, read.error, read.message, NO_STORE);
  if (read.sha256 !== header.sha256)
    return errorResponse(400, "invalid_package", "内容摘要与 X-Content-SHA256 头不一致。", NO_STORE);

  const gate = await checkReleaseVersion(header.name, header.version);
  if (!gate.ok) return errorResponse(409, gate.error, gate.message, NO_STORE);

  // 孤儿版本允许（先 publish 后 product 注册）；私有仓 + 随机后缀键，失败上抛 500 不落库
  const blob = await blobStore().put(header.name, header.version, read.bytes);
  const stored = await insertRelease({
    skill: header.name, version: header.version, sha256: read.sha256,
    size: read.bytes.length, notes: header.notes, blobPath: blob.path,
  });
  if (!stored.ok) return errorResponse(409, stored.error, stored.message, NO_STORE);

  return Response.json(
    { skill: header.name, version: header.version, sha256: read.sha256, size: read.bytes.length, url: downloadUrlFor(siteBase(request), header.name, header.version) },
    { headers: NO_STORE },
  );
}
