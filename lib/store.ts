import { getSql } from "./db";
import { applyProductUpdate } from "./store-core.mjs";

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

// 表很小且冲突判定要看全目录的 skill 占用：一次全量读，纯逻辑终审后整体写回

/** 商品注册/合并更新：按 id/free_skill/paid_skill 任一命中即合并更新，否则以 URL 规范名创建。
 *  fields 只含调用方提供的键；唯一约束竞态（并发注册同一 skill 名）兜底转 400。 */
export async function upsertProduct(skill: string, fields: unknown): Promise<UpsertResult> {
  const sql = getSql();
  const rows = await sql<ProductRow[]>`select id, name, summary, repo, page, free_skill, paid_skill, prices from products`;
  const domain = rows.map(toCatalog);
  const index = domain.findIndex((item) => item.id === skill || item.free?.skill === skill || item.paid?.skill === skill);
  const existing = index === -1 ? null : domain[index];
  const others = index === -1 ? domain : domain.filter((_, i) => i !== index);
  const applied = applyProductUpdate(skill, fields, existing, others);
  if (!applied.ok) return applied;
  const next = applied.product;
  try {
    if (existing) {
      await sql`update products set name = ${next.name}, summary = ${next.summary}, repo = ${next.repo},
        page = ${next.page}, free_skill = ${next.free?.skill ?? null}, paid_skill = ${next.paid?.skill ?? null},
        prices = ${sql.json(next.prices)}, updated_at = now() where id = ${existing.id}`;
    } else {
      await sql`insert into products (id, name, summary, repo, page, free_skill, paid_skill, prices)
        values (${next.id}, ${next.name}, ${next.summary}, ${next.repo}, ${next.page},
          ${next.free?.skill ?? null}, ${next.paid?.skill ?? null}, ${sql.json(next.prices)})`;
    }
  } catch (error) {
    // 23505 唯一冲突 = 并发窗口里 skill 名被别商品占走：与终审同文案回 400，不泄内部细节
    if (error && typeof error === "object" && (error as { code?: string }).code === "23505") {
      const claimed = next.paid?.skill ?? next.free?.skill ?? skill;
      return { ok: false, error: "invalid_field", message: `${claimed} 已属于其他商品。` };
    }
    throw error;
  }
  return { ok: true, product: next };
}
