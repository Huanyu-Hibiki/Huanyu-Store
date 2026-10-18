import { getSql } from "./db";
import { applyProductUpdate, isCanonicalSkillName } from "./store-core.mjs";

/** 目录/商品响应形状（catalog 形状，逐字过 CLI normalizeCatalog：
 *  id 非空、name 非空、free/paid 为 null 或 {skill}、prices 为对象）。 */
export type CatalogProduct = {
  id: string;
  name: string;
  summary: string;
  repo: string | null;
  page: string | null;
  free: { skill: string } | null;
  paid: { skill: string } | null;
  prices: Record<string, { amount: number; currency: string; interval?: string | null }>;
};

type ProductRow = {
  id: string; name: string; summary: string | null; repo: string | null; page: string | null;
  free_skill: string | null; paid_skill: string | null; prices: Record<string, unknown> | null;
};

function toCatalog(row: ProductRow): CatalogProduct {
  return {
    id: row.id, name: row.name, summary: row.summary ?? "", repo: row.repo, page: row.page,
    free: row.free_skill ? { skill: row.free_skill } : null,
    paid: row.paid_skill ? { skill: row.paid_skill } : null,
    prices: (row.prices ?? {}) as CatalogProduct["prices"],
  };
}

/** 公开目录（无鉴权）：按创建顺序稳定排列。 */
export async function listCatalog(): Promise<CatalogProduct[]> {
  const sql = getSql();
  const rows = await sql<ProductRow[]>`select id, name, summary, repo, page, free_skill, paid_skill, prices
    from products order by created_at, id`;
  return rows.map(toCatalog);
}

export type UpsertResult =
  | { ok: true; product: CatalogProduct }
  | { ok: false; error: "invalid_field"; message: string };

// 23505 唯一冲突 → 撞名值指名：pkey 即 URL 规范名；free/paid 键撞车优先取本次提供的值，
// 未提供时（既有值被并发占走，罕见）回落 URL 名——文案尽力精确，语义不变
function claimedSkill(constraint: string | undefined, skill: string, fields: unknown): string {
  if (constraint === "products_free_skill_key" && typeof (fields as { free?: unknown })?.free === "string")
    return (fields as { free: string }).free;
  if (constraint === "products_paid_skill_key" && typeof (fields as { paid?: unknown })?.paid === "string")
    return (fields as { paid: string }).paid;
  return skill;
}

/** 商品注册/合并更新：按 id/free_skill/paid_skill 任一命中即合并更新，否则以 URL 规范名创建。
 *  fields 只含调用方提供的键；整体在事务 + 全表行锁下读写（表小、写者是少数 publisher，
 *  统一锁序无死锁）——同商品并发合并不再丢失更新；创建路径不加咨询锁，
 *  并发同 id/同 skill 名双插由唯一约束兜底（23505 → 400，结果确定性见并发测试）。 */
export async function upsertProduct(skill: string, fields: unknown): Promise<UpsertResult> {
  // 规范名前置早退：不合法的 skill 名不触库
  if (!isCanonicalSkillName(skill)) return { ok: false, error: "invalid_field", message: "Skill 名无效。" };
  const sql = getSql();
  try {
    return await sql.begin(async (tx) => {
      const rows = await tx<ProductRow[]>`select id, name, summary, repo, page, free_skill, paid_skill, prices
        from products for update`;
      const domain = rows.map(toCatalog);
      const index = domain.findIndex((item) => item.id === skill || item.free?.skill === skill || item.paid?.skill === skill);
      const existing = index === -1 ? null : domain[index];
      const others = index === -1 ? domain : domain.filter((_, i) => i !== index);
      const applied = applyProductUpdate(skill, fields, existing, others);
      if (!applied.ok) return applied;
      const next = applied.product;
      if (existing) {
        await tx`update products set name = ${next.name}, summary = ${next.summary}, repo = ${next.repo},
          page = ${next.page}, free_skill = ${next.free?.skill ?? null}, paid_skill = ${next.paid?.skill ?? null},
          prices = ${tx.json(next.prices)}, updated_at = now() where id = ${existing.id}`;
      } else {
        await tx`insert into products (id, name, summary, repo, page, free_skill, paid_skill, prices)
          values (${next.id}, ${next.name}, ${next.summary}, ${next.repo}, ${next.page},
            ${next.free?.skill ?? null}, ${next.paid?.skill ?? null}, ${tx.json(next.prices)})`;
      }
      return { ok: true as const, product: next };
    });
  } catch (error) {
    // 23505 = 并发窗口里 skill 名被占走（products_pkey / products_free_skill_key / products_paid_skill_key）：
    // 与终审同文案回 400，按约束指名撞车值，不泄内部细节。须在 begin 外捕获——事务已中止，
    // 回调内吞错再 commit 会因 aborted 事务失败（实测 postgres.js 行为）
    const pgError = error as { code?: string; constraint_name?: string };
    if (pgError?.code === "23505") {
      const claimed = claimedSkill(pgError.constraint_name, skill, fields);
      return { ok: false, error: "invalid_field", message: `${claimed} 已属于其他商品。` };
    }
    throw error;
  }
}
