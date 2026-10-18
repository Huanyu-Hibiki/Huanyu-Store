import { getSql } from "./db";
import { RELEASES_PER_SKILL_MAX, compareVersions, isReleaseCountLimited, versionsPayload, type SkillVersions } from "./publish-core.mjs";

export type ReleaseGate =
  | { ok: true }
  | { ok: false; error: "version_exists" | "version_regression" | "version_limit"; message: string };

type ReleaseRow = { skill: string; version: string; sha256: string; notes: string | null; yanked: boolean; published_at: Date };

/** 版本落库（检查 + 写 Blob + 插入同一事务，quality M2）：事务首步 pg_advisory_xact_lock
 *  串行化同 skill 的并发发布——否则两路并发（2.0.0 与 1.5.0）的预检都在对方插入前通过，
 *  低版本穿窗入库。锁粒度 = hashtext('releases:'||skill)，写 Blob（≤4MB）期间持锁是取舍：
 *  发布是低频人工操作，换来拒绝语义的确定性。
 *  判定序：已存在 409 version_exists（不比对历史 sha，契约幂等语义）→ 低于最高 409
 *  version_regression（跳版本放行）→ count≥200 409 version_limit（security M-1）→ write → 插入。
 *  Blob 写失败异常上抛回滚（500，不落库）；已写未提交的 blob 属无害孤儿（随机后缀路径不可发现）。 */
export async function storeRelease(input: {
  skill: string; version: string; sha256: string; size: number; notes: string | null; bytes: Buffer;
  write: (skill: string, version: string, bytes: Buffer) => Promise<{ path: string }>;
}): Promise<ReleaseGate> {
  const sql = getSql();
  try {
    return await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('releases:' || ${input.skill}))`;
      const rows = await tx<{ version: string }[]>`select version from releases where skill = ${input.skill}`;
      if (rows.some((row) => row.version === input.version))
        return { ok: false as const, error: "version_exists", message: "该版本已发布。" };
      const highest = rows.reduce<string | null>(
        (best, row) => (best === null || compareVersions(row.version, best) > 0 ? row.version : best), null);
      if (highest !== null && compareVersions(input.version, highest) < 0)
        return { ok: false as const, error: "version_regression", message: `${input.version} 低于已发布的最高版本 ${highest}，版本号只能递增。` };
      if (isReleaseCountLimited(rows.length))
        return { ok: false as const, error: "version_limit", message: `该 skill 已有 ${rows.length} 个版本，达到上限 ${RELEASES_PER_SKILL_MAX}，请先下架旧版本再发布。` };
      const blob = await input.write(input.skill, input.version, input.bytes);
      await tx`insert into releases (skill, version, sha256, size, notes, blob_path)
        values (${input.skill}, ${input.version}, ${input.sha256}, ${input.size}, ${input.notes}, ${blob.path})`;
      return { ok: true as const };
    });
  } catch (error) {
    // 锁已排除同 (skill,version) 并发；主键 23505 兜底保持语义（防御未来绕过锁的路径）
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
