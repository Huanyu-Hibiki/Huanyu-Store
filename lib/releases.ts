import { getSql } from "./db";
import { compareVersions, versionsPayload, type SkillVersions } from "./publish-core.mjs";

export type VersionGate =
  | { ok: true }
  | { ok: false; error: "version_exists" | "version_regression"; message: string };

type ReleaseRow = { skill: string; version: string; sha256: string; notes: string | null; yanked: boolean; published_at: Date };

/** 版本单调性预检（Blob 写入前，便宜检查）：(skill,version) 已存在 → 409 version_exists（唯一拒绝，
 *  不比对历史 sha——跨机器重打包字节不同，契约预期 409）；低于现有最高版本 → 409 version_regression
 *  （CLI 对未知 409 code 展示 message，文案指明两个版本号）；跳版本放行。 */
export async function checkReleaseVersion(skill: string, version: string): Promise<VersionGate> {
  const sql = getSql();
  const rows = await sql<{ version: string }[]>`select version from releases where skill = ${skill}`;
  if (rows.some((row) => row.version === version)) return { ok: false, error: "version_exists", message: "该版本已发布。" };
  const highest = rows.reduce<string | null>((best, row) => (best === null || compareVersions(row.version, best) > 0 ? row.version : best), null);
  if (highest !== null && compareVersions(version, highest) < 0)
    return { ok: false, error: "version_regression", message: `${version} 低于已发布的最高版本 ${highest}，版本号只能递增。` };
  return { ok: true };
}

/** 插入版本记录。并发同 (skill,version) 由主键唯一约束兜底（预检与插入间的竞态）→ 409 version_exists；
 *  Blob 已写而插入失败属无害孤儿对象（按随机后缀路径不可发现），重试落新键。 */
export async function insertRelease(input: {
  skill: string; version: string; sha256: string; size: number; notes: string | null; blobPath: string;
}): Promise<VersionGate> {
  const sql = getSql();
  try {
    await sql`insert into releases (skill, version, sha256, size, notes, blob_path)
      values (${input.skill}, ${input.version}, ${input.sha256}, ${input.size}, ${input.notes}, ${input.blobPath})`;
    return { ok: true };
  } catch (error) {
    if ((error as { code?: string }).code === "23505")
      return { ok: false, error: "version_exists", message: "该版本已发布。" };
    throw error;
  }
}

/** versions 载荷：全部版本行 + 目录名字（未发布者占位）→ {skills}（组装纯逻辑在 publish-core.versionsPayload）。 */
export async function listVersions(
  urlFor: (skill: string, version: string) => string,
): Promise<{ skills: Record<string, SkillVersions> }> {
  const sql = getSql();
  const rows = await sql<ReleaseRow[]>`select skill, version, sha256, notes, yanked, published_at from releases`;
  const products = await sql<{ free_skill: string | null; paid_skill: string | null }[]>`select free_skill, paid_skill from products`;
  const catalogNames = products.flatMap((row) => [row.free_skill, row.paid_skill]).filter((name): name is string => Boolean(name));
  return { skills: versionsPayload(rows, catalogNames, urlFor) };
}
