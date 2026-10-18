/** 验证码登录的纯逻辑（无 DB/运行时依赖），供 node:test 直接单测与 lib/auth.ts 复用。 */
import { createHash,randomBytes,randomInt } from 'node:crypto';

export const SESSION_COOKIE='huanyu_session';
export const CODE_TTL_MINUTES=10;
export const CODE_MAX_ATTEMPTS=5;
export const EMAIL_HOURLY_LIMIT=5;
export const IP_HOURLY_LIMIT=20;
export const SESSION_TTL_DAYS=30;

/** @param {string} input @returns {string} */
export function sha256Hex(input){
 return createHash('sha256').update(input).digest('hex');
}

/** 邮箱归一：去空白 + 小写，作为账号唯一键与哈希绑定输入。 @param {string} raw @returns {string} */
export function normalizeEmail(raw){
 return raw.trim().toLowerCase();
}

/** 验证码哈希绑定 email：同一验证码在不同邮箱下哈希不同，且不等于裸码哈希（防彩虹表对照）。 */
export function hashCode(email,code){
 return sha256Hex(`${normalizeEmail(email)}:${code}`);
}

/** 6 位数字验证码（补零），随机均匀取值。 @returns {string} */
export function generateCode(){
 return String(randomInt(0,1_000_000)).padStart(6,'0');
}

/** Web 会话令牌：32 字节 urlsafe 随机，cookie 存原值、库中只存 sha256。 @returns {string} */
export function generateSessionToken(){
 return randomBytes(32).toString('base64url');
}

/** @typedef {{code_hash:string,attempts:number,expires_at:Date,used_at:Date|null}} CodeRow @returns {'valid'|'mismatch'|'expired'|'used'|'exhausted'} */
export function checkCode(row,email,code,now=new Date()){
 if (row.used_at) return 'used';
 if (row.expires_at.getTime()<=now.getTime()) return 'expired';
 if (row.attempts>=CODE_MAX_ATTEMPTS) return 'exhausted'; // 尝试耗尽先于比对：正确码也作废
 return row.code_hash===hashCode(email,code)?'valid':'mismatch';
}

/** 发信限频判定：任一维度达到上限即拒。 @param {{emailCount:number,ipCount:number}} counts @returns {boolean} */
export function isSendRateLimited({emailCount,ipCount}){
 return emailCount>=EMAIL_HOURLY_LIMIT||ipCount>=IP_HOURLY_LIMIT;
}

/** 边界邮箱形状校验（快速失败）；送达性由验证码邮件本身承担。 @param {string} email @returns {boolean} */
export function isValidEmail(email){
 return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
