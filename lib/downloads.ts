import { getSql } from "./db";

export type ReleaseTargetRow = { version: string; sha256: string; size: number; blob_path: string; yanked: boolean };

/** 某 skill 的全部版本行（download 裁决输入；yank 过滤在纯逻辑 resolveDownload）。 */
export async function getSkillReleases(skill: string): Promise<ReleaseTargetRow[]> {
  const sql = getSql();
  return sql<ReleaseTargetRow[]>`select version, sha256, size, blob_path, yanked from releases where skill = ${skill}`;
}

/** 目录角色快照：paidSkills = 全部商品的付费名（402 闸门），catalogNames = 全部目录名（未知判定）。 */
export async function getSkillRoles(): Promise<{ paidSkills: Set<string>; catalogNames: Set<string> }> {
  const sql = getSql();
  const rows = await sql<{ free_skill: string | null; paid_skill: string | null }[]>`select free_skill, paid_skill from products`;
  const paidSkills = new Set<string>(), catalogNames = new Set<string>();
  for (const row of rows) {
    if (row.paid_skill) { paidSkills.add(row.paid_skill); catalogNames.add(row.paid_skill); }
    if (row.free_skill) catalogNames.add(row.free_skill);
  }
  return { paidSkills, catalogNames };
}
