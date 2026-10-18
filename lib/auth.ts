import { randomUUID } from "node:crypto";
import {
  CODE_TTL_MINUTES, GLOBAL_DAILY_LIMIT, SESSION_TTL_DAYS, VERIFY_IP_HOURLY_LIMIT,
  checkCode, generateCode, generateSessionToken, hashCode, isSendRateLimited, sha256Hex,
} from "./auth-core.mjs";
import { getSql } from "./db";
import { SENDER_FROM, mailSender } from "./email";

export type IssueResult = { ok: true } | { ok: false; error: "rate_limited" } | { ok: false; error: "send_failed"; reason: string };
export type VerifyResult = { ok: true; email: string; token: string } | { ok: false };

/** 发验证码。限频语义：per-key（邮箱/IP）基于可伪造的 x-forwarded-for，为 best-effort 纵深；
 *  全局 24h 日预算不可绕过，兜底防 Resend 配额被耗尽成全站登录 DoS。email/ip 须已归一。 */
export async function requestLoginCode(email: string, ip: string): Promise<IssueResult> {
  const sql = getSql();
  const [counts] = await sql`
    select (count(*) filter (where email = ${email} and created_at > now() - interval '1 hour'))::int as email_count,
           (count(*) filter (where ip = ${ip} and created_at > now() - interval '1 hour'))::int as ip_count,
           (count(*) filter (where created_at > now() - interval '24 hours'))::int as daily_count
    from login_codes
    where created_at > now() - interval '24 hours'`;
  if (counts.daily_count >= GLOBAL_DAILY_LIMIT) return { ok: false, error: "rate_limited" };
  if (isSendRateLimited({ emailCount: counts.email_count, ipCount: counts.ip_count })) {
    return { ok: false, error: "rate_limited" };
  }
  const code = generateCode();
  const codeHash = hashCode(email, code);
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60_000);
  await sql`insert into login_codes (email, code_hash, ip, expires_at) values (${email}, ${codeHash}, ${ip}, ${expiresAt})`;
  try {
    await mailSender()({
      from: SENDER_FROM,
      to: email,
      subject: "焕羽 Skills 商店登录验证码",
      text: `你的登录验证码是 ${code}，${CODE_TTL_MINUTES} 分钟内有效。若非本人操作，请忽略本邮件。`,
    });
  } catch (error) {
    // 发信失败 best-effort 清理刚插入的码行：不占限频额度、不留未送达的有效码
    await sql`delete from login_codes where email = ${email} and code_hash = ${codeHash} and expires_at = ${expiresAt}`
      .catch(() => {});
    return { ok: false, error: "send_failed", reason: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true };
}

/** verify 端点每 IP 限频（纵深，best-effort）：按该 IP 请求过的码的累计失败尝试计数，键/预算与发码限频分开。 */
export async function isVerifyRateLimited(ip: string): Promise<boolean> {
  const sql = getSql();
  const [row] = await sql`
    select coalesce(sum(attempts), 0)::int as failed from login_codes
    where ip = ${ip} and created_at > now() - interval '1 hour'`;
  return row.failed >= VERIFY_IP_HOURLY_LIMIT;
}

/** 校验验证码：通过即 upsert 用户（新邮箱即注册）+ 建 30 天会话，返回 cookie 原始令牌。
 *  整个「读 attempts→判定→递增/消费」在事务内对最新码行 select ... for update——行锁串行化并发验证，
 *  并发第 6 次必然读到 attempts≥5 → exhausted 不再比对（TOCTOU 闭合）。
 *  码行定位用（email, code_hash, expires_at）：expires_at 由 JS 毫秒精度生成，往返精确相等。 */
export async function verifyLoginCode(email: string, code: string): Promise<VerifyResult> {
  const sql = getSql();
  return sql.begin(async (tx) => {
    const [row] = await tx`
      select code_hash, attempts, expires_at, used_at from login_codes
      where email = ${email} and used_at is null
      order by created_at desc limit 1
      for update`;
    if (!row) return { ok: false };
    const verdict = checkCode(row, email, code);
    if (verdict === "mismatch") {
      await tx`update login_codes set attempts = attempts + 1
        where email = ${email} and code_hash = ${row.code_hash} and expires_at = ${row.expires_at} and used_at is null`;
      return { ok: false }; // 满 5 次后由 checkCode 判 exhausted 作废
    }
    if (verdict !== "valid") return { ok: false };
    const consumed = await tx`update login_codes set used_at = now()
      where email = ${email} and code_hash = ${row.code_hash} and expires_at = ${row.expires_at} and used_at is null`;
    if (consumed.count === 0) return { ok: false }; // 并发验证已消费该码
    const token = generateSessionToken();
    const [user] = await tx`
      insert into users (id, email, last_login_at) values (${randomUUID()}, ${email}, now())
      on conflict (email) do update set last_login_at = now()
      returning id, email`;
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 3600 * 1000);
    await tx`insert into web_sessions (id, user_id, token_hash, expires_at)
      values (${randomUUID()}, ${user.id}, ${sha256Hex(token)}, ${expiresAt})`;
    return { ok: true, email: user.email, token };
  });
}

/** 按 cookie 令牌查会话所属邮箱；未登录/已过期/已撤销返回 null。 */
export async function getSessionEmail(token: string): Promise<string | null> {
  const sql = getSql();
  const [row] = await sql`
    select u.email from web_sessions s join users u on u.id = s.user_id
    where s.token_hash = ${sha256Hex(token)} and s.expires_at > now() limit 1`;
  return row?.email ?? null;
}

/** 撤销会话（登出）：删除令牌哈希所在行，幂等。 */
export async function revokeSession(token: string): Promise<void> {
  const sql = getSql();
  await sql`delete from web_sessions where token_hash = ${sha256Hex(token)}`;
}
