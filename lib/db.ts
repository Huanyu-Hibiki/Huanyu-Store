import postgres from "postgres";

type SqlClient = ReturnType<typeof postgres>;

let client: SqlClient | null = null;

/** 惰性单例：首次查询时才按 DATABASE_URL 建连，无库环境在 import 阶段不崩，探针可显式报告。 */
function getSql(): SqlClient {
  if (!client) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("缺少 DATABASE_URL 环境变量");
    client = postgres(url);
  }
  return client;
}

/** 数据库探针：不抛异常，把连通或失败原因交还调用方（如 /api/health）显式报告。 */
export async function pingDatabase(): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await getSql()`select 1`;
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
