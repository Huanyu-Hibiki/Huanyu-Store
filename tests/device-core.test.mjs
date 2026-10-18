import test from 'node:test';
import assert from 'node:assert/strict';
import {
 DEVICE_TTL_SECONDS,DEVICE_INTERVAL_SECONDS,CLI_TOKEN_PREFIX,DEVICE_IP_HOURLY_LIMIT,DEVICE_GLOBAL_DAILY_LIMIT,
 generateDeviceCode,generateCliToken,generateUserCode,normalizeUserCode,checkGrant,isIssueRateLimited,isPublisher,
} from '../lib/device-core.mjs';

test('设备码参数与 CLI 契约一致：TTL 600 秒、interval 5 秒、令牌 hy_ 前缀',()=>{
 assert.equal(DEVICE_TTL_SECONDS,600);
 assert.equal(DEVICE_INTERVAL_SECONDS,5);
 assert.equal(CLI_TOKEN_PREFIX,'hy_');
});

test('设备签发限频规格：每 IP 10 次/小时、全局日预算 2000',()=>{
 assert.equal(DEVICE_IP_HOURLY_LIMIT,10);
 assert.equal(DEVICE_GLOBAL_DAILY_LIMIT,2000);
 assert.equal(isIssueRateLimited({ipCount:9,dailyCount:1999}),false);
 assert.equal(isIssueRateLimited({ipCount:10,dailyCount:0}),true,'IP 到限即拒');
 assert.equal(isIssueRateLimited({ipCount:0,dailyCount:2000}),true,'全局日预算到限即拒');
});

test('generateDeviceCode：43 字符 urlsafe 高熵且不重复',()=>{
 const codes=Array.from({length:100},generateDeviceCode);
 for(const code of codes) assert.match(code,/^[A-Za-z0-9_-]{43}$/);
 assert.equal(new Set(codes).size,100);
});

test('generateCliToken：hy_ + 43 字符 urlsafe 且不重复',()=>{
 const tokens=Array.from({length:50},generateCliToken);
 for(const token of tokens) assert.match(token,/^hy_[A-Za-z0-9_-]{43}$/);
 assert.equal(new Set(tokens).size,50);
});

test('generateUserCode：XXXX-XXXX 大写字母数字，排除易混淆字符（0/O/1/I/L）',()=>{
 const codes=Array.from({length:200},generateUserCode);
 for(const code of codes){
  assert.match(code,/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  for(const char of code.replace('-','')) assert.ok(!'0O1IL'.includes(char),`易混淆字符 ${char} 不应出现`);
 }
 assert.equal(new Set(codes).size,200);
});

test('normalizeUserCode：容错手输（去分隔符/空白、大写、重组 XXXX-XXXX），形状非法返回 null',()=>{
 assert.equal(normalizeUserCode('ABCD-2345'),'ABCD-2345');
 assert.equal(normalizeUserCode('abcd2345'),'ABCD-2345');
 assert.equal(normalizeUserCode(' ab cd - 23 45 '),'ABCD-2345');
 assert.equal(normalizeUserCode(null),null);
 assert.equal(normalizeUserCode(''),null);
 assert.equal(normalizeUserCode('ABC'),null);
 assert.equal(normalizeUserCode('ABCD23456'),null);
 assert.equal(normalizeUserCode('ABCD2340'),null,'含 0（易混淆）');
 assert.equal(normalizeUserCode('ABCD234I'),null,'含 I（易混淆）');
 assert.equal(normalizeUserCode('ABCD234O'),null,'含 O（易混淆）');
 assert.equal(normalizeUserCode('ABCD2341'),null,'含 1（易混淆）');
 assert.equal(normalizeUserCode('ABCD234L'),null,'含 L（易混淆）');
});

// 单时钟契约：checkGrant 的 now 一律由调用方传入（生产路径为事务首查带回的 DB now()），测试注入固定值
const DB_NOW=new Date('2026-10-18T12:00:00.000Z');
const grantRow=(overrides={})=>({
 status:'pending',
 expires_at:new Date(DB_NOW.getTime()+600_000),
 last_poll_at:null,
 interval_seconds:5,
 ...overrides,
});

test('checkGrant 状态机：pending 首轮放行、快于 interval 一半 slow_down、够时距恢复 pending',()=>{
 assert.equal(checkGrant(grantRow(),DB_NOW),'pending','无轮询记录：首轮不算过快');
 assert.equal(checkGrant(grantRow({last_poll_at:new Date(DB_NOW.getTime()-1000)}),DB_NOW),'slow_down');
 assert.equal(checkGrant(grantRow({last_poll_at:new Date(DB_NOW.getTime()-2499)}),DB_NOW),'slow_down');
 assert.equal(checkGrant(grantRow({last_poll_at:new Date(DB_NOW.getTime()-2500)}),DB_NOW),'pending','恰好 interval/2 不算过快');
 assert.equal(checkGrant(grantRow({last_poll_at:new Date(DB_NOW.getTime()-5000)}),DB_NOW),'pending');
 // interval 自定义：阈值随行内 interval_seconds 变化
 assert.equal(checkGrant(grantRow({interval_seconds:10,last_poll_at:new Date(DB_NOW.getTime()-4000)}),DB_NOW),'slow_down');
 assert.equal(checkGrant(grantRow({interval_seconds:10,last_poll_at:new Date(DB_NOW.getTime()-5000)}),DB_NOW),'pending');
});

test('checkGrant 终态判定：approved/denied 直出，过期优先于一切状态',()=>{
 assert.equal(checkGrant(grantRow({status:'approved'}),DB_NOW),'approved');
 assert.equal(checkGrant(grantRow({status:'denied'}),DB_NOW),'denied');
 const expired={expires_at:new Date(DB_NOW.getTime()-1)};
 assert.equal(checkGrant(grantRow(expired),DB_NOW),'expired');
 assert.equal(checkGrant(grantRow({...expired,status:'approved'}),DB_NOW),'expired','过期优先于 approved');
 assert.equal(checkGrant(grantRow({...expired,status:'denied'}),DB_NOW),'expired','过期优先于 denied');
});

test('isPublisher：白名单逗号分隔、忽略大小写与空白；未配置恒 false',()=>{
 const env='Publisher@Example.com , second.publisher@example.com';
 assert.equal(isPublisher('publisher@example.com',env),true);
 assert.equal(isPublisher('SECOND.Publisher@example.com',env),true);
 assert.equal(isPublisher('reader@example.com',env),false);
 assert.equal(isPublisher('publisher@example.com',undefined),false);
 assert.equal(isPublisher('publisher@example.com',''),false);
 assert.equal(isPublisher('publisher@example.com','   '),false);
 assert.equal(isPublisher('  publisher@example.com  ',env),true,'比对前邮箱归一');
});
