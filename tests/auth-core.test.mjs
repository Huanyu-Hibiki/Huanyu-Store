import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
 SESSION_COOKIE,CODE_TTL_MINUTES,CODE_MAX_ATTEMPTS,EMAIL_HOURLY_LIMIT,IP_HOURLY_LIMIT,SESSION_TTL_DAYS,
 sha256Hex,normalizeEmail,hashCode,generateCode,generateSessionToken,checkCode,isSendRateLimited,isValidEmail,
} from '../lib/auth-core.mjs';

test('登录参数与规格一致：TTL 10 分钟、尝试 5 次、限频 5/20、会话 30 天、cookie 具名',()=>{
 assert.equal(CODE_TTL_MINUTES,10);
 assert.equal(CODE_MAX_ATTEMPTS,5);
 assert.equal(EMAIL_HOURLY_LIMIT,5);
 assert.equal(IP_HOURLY_LIMIT,20);
 assert.equal(SESSION_TTL_DAYS,30);
 assert.equal(typeof SESSION_COOKIE,'string');
 assert.ok(SESSION_COOKIE.length>0);
});

test('sha256Hex 与 node:crypto 结果一致',()=>{
 assert.equal(sha256Hex('abc'),createHash('sha256').update('abc').digest('hex'));
 assert.equal(sha256Hex('你好'),createHash('sha256').update('你好').digest('hex'));
});

test('normalizeEmail 去空白并小写归一',()=>{
 assert.equal(normalizeEmail('  Mixed.Case@Example.COM '),'mixed.case@example.com');
 assert.equal(normalizeEmail('USER@host.io'),'user@host.io');
});

test('hashCode 绑定邮箱：同码不同邮箱哈希不同，且不是裸码哈希（防彩虹对照）',()=>{
 const a=hashCode('a@example.com','123456'),b=hashCode('b@example.com','123456');
 assert.notEqual(a,b);
 assert.equal(a,sha256Hex('a@example.com:123456'));
 assert.notEqual(a,sha256Hex('123456')); // 库中拿到的哈希无法与公开彩虹表对照
 assert.equal(hashCode('Mixed@Example.com','123456'),hashCode('mixed@example.com','123456')); // 归一后再哈希
});

test('generateCode 恒为 6 位数字',()=>{
 for(let i=0;i<200;i++) assert.match(generateCode(),/^\d{6}$/);
});

test('generateSessionToken 为 urlsafe 随机串且不重复',()=>{
 const seen=new Set();
 for(let i=0;i<100;i++){
  const token=generateSessionToken();
  assert.match(token,/^[A-Za-z0-9_-]+$/);
  assert.equal(token.length,43); // 32 字节 base64url
  assert.ok(!seen.has(token));
  seen.add(token);
 }
});

test('checkCode 判定次序：used → expired → exhausted（先于比对）→ 哈希比对',()=>{
 const email='u@example.com',code='654321';
 const base={code_hash:hashCode(email,code),attempts:0,expires_at:new Date(Date.now()+10*60_000),used_at:null};
 assert.equal(checkCode(base,email,code),'valid');
 assert.equal(checkCode(base,email,'000000'),'mismatch');
 assert.equal(checkCode({...base,expires_at:new Date(Date.now()-1)},email,code),'expired'); // 正确码但过期
 assert.equal(checkCode({...base,used_at:new Date()},email,code),'used');
 assert.equal(checkCode({...base,attempts:5},email,code),'exhausted'); // 正确码但尝试耗尽：作废优先
 assert.equal(checkCode({...base,attempts:4},email,code),'valid'); // 第 5 次尝试仍可用
});

test('isSendRateLimited 边界：任一维度到限即拒',()=>{
 assert.equal(isSendRateLimited({emailCount:5,ipCount:0}),true);
 assert.equal(isSendRateLimited({emailCount:0,ipCount:20}),true);
 assert.equal(isSendRateLimited({emailCount:5,ipCount:20}),true);
 assert.equal(isSendRateLimited({emailCount:4,ipCount:19}),false);
});

test('isValidEmail 边界形状校验',()=>{
 assert.equal(isValidEmail('u@example.com'),true);
 assert.equal(isValidEmail('a.b@sub.example.co'),true);
 assert.equal(isValidEmail('not-an-email'),false);
 assert.equal(isValidEmail('a@b'),false);
 assert.equal(isValidEmail('a b@example.com'),false);
 assert.equal(isValidEmail(''),false);
});
