import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mailSender,SENDER_FROM } from '../lib/email.mjs';

const mail={from:SENDER_FROM,to:'u@example.com',subject:'测试验证码',text:'你的验证码是 123456'};

test('发信人显示名与地址符合规格',()=>{
 assert.equal(SENDER_FROM,'焕羽 Skills 商店 <noreply@skills.huanyu.dev>');
});

test('未配 RESEND_API_KEY → 假发送器：记录待发内容（供测试断言/本地开发查看），不发网络请求',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'huanyu-mail-test-'));
 const outbox=path.join(dir,'outbox.jsonl');
 const previousKey=process.env.RESEND_API_KEY,previousOutbox=process.env.FAKE_MAIL_OUTBOX;
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async()=>{throw new Error('假发送器不得发起网络请求');};
 try{
  delete process.env.RESEND_API_KEY;
  process.env.FAKE_MAIL_OUTBOX=outbox;
  await mailSender()(mail);
  const lines=readFileSync(outbox,'utf8').split(/\r?\n/).filter(Boolean).map((line)=>JSON.parse(line));
  assert.deepEqual(lines,[mail]);
 }finally{
  globalThis.fetch=originalFetch;
  if (previousKey===undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY=previousKey;
  if (previousOutbox===undefined) delete process.env.FAKE_MAIL_OUTBOX; else process.env.FAKE_MAIL_OUTBOX=previousOutbox;
  rmSync(dir,{recursive:true,force:true});
 }
});

test('配了 RESEND_API_KEY → 真发：fetch 直调 Resend REST API，不引 SDK',async()=>{
 const calls=[];
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async(url,init)=>{
  calls.push({url:String(url),init});
  return new Response('{"id":"test"}',{status:200});
 };
 try{
  process.env.RESEND_API_KEY='re_test_key';
  await mailSender()(mail);
 }finally{
  globalThis.fetch=originalFetch;
  delete process.env.RESEND_API_KEY;
 }
 assert.equal(calls.length,1);
 assert.equal(calls[0].url,'https://api.resend.com/emails');
 assert.equal(calls[0].init.method,'POST');
 assert.equal(calls[0].init.headers.authorization,'Bearer re_test_key');
 assert.deepEqual(JSON.parse(calls[0].init.body),{from:mail.from,to:[mail.to],subject:mail.subject,text:mail.text});
});

test('Resend 返回非 2xx → 抛错（调用方以 email_send_failed 兜底）',async()=>{
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async()=>new Response('{"error":"domain not verified"}',{status:403});
 try{
  process.env.RESEND_API_KEY='re_test_key';
  await assert.rejects(mailSender()(mail),/Resend 403/);
 }finally{
  globalThis.fetch=originalFetch;
  delete process.env.RESEND_API_KEY;
 }
});
