import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const url=process.env.STORE_URL||'http://127.0.0.1:3001';
const browser=await chromium.launch({channel:'msedge',headless:true});
const checks=[];
try {
 for(let run=1;run<=3;run++){
  const context=await browser.newContext({viewport:{width:1440,height:900},permissions:['clipboard-read','clipboard-write'],reducedMotion:'reduce'});
  const page=await context.newPage();page.setDefaultTimeout(10000);page.setDefaultNavigationTimeout(20000);console.log('Run',run,'navigation');const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url,{waitUntil:'domcontentloaded'});await expect(page.locator('.store-product')).toHaveCount(3);
  for(const id of ['founder-ip','oracle-bone','pulsehub']){
   await page.locator(`#product-toggle-${id}`).click();await expect(page.locator('.product-preview:visible')).toHaveCount(1);await expect(page.locator(`#product-preview-${id}`)).toBeVisible();
  }
  await page.getByRole('button',{name:'复制示例'}).last().click();await expect(page.getByRole('button',{name:'已复制 ✓'})).toBeVisible();console.log('Preview copy passed');
  await page.getByRole('button',{name:'版本与授权',exact:true}).last().click();await expect(page.getByRole('dialog')).toContainText('获客闭环');await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button',{name:'内容与表达',exact:true}).click();await expect(page.locator('.store-product')).toHaveCount(1);await expect(page.locator('.product-toggle')).toHaveAttribute('aria-expanded','false');
  await page.getByRole('button',{name:'全部',exact:true}).click();await page.getByRole('searchbox').fill('ORACLE-BONE');await expect(page.locator('.store-product')).toHaveCount(1);
  await page.getByRole('searchbox').fill('不存在');await expect(page.getByText('没有找到匹配的技能')).toBeVisible();await page.getByRole('button',{name:'清除搜索与筛选'}).click();await expect(page.locator('.store-product')).toHaveCount(3);
  console.log('Catalog passed');await page.locator('.header-login').click();await expect(page.getByRole('dialog')).toBeVisible();expect(await page.locator('.page-frame').evaluate(e=>e.inert)).toBe(true);
  await page.keyboard.press('Shift+Tab');expect(await page.evaluate(()=>document.activeElement?.textContent)).toBe('隐私政策');await page.keyboard.press('Tab');await expect(page.getByRole('button',{name:'关闭登录窗口'})).toBeFocused();
  await page.getByRole('tab',{name:'注册新账户'}).click();await expect(page.getByLabel('如何称呼你')).toBeVisible();await page.keyboard.press('ArrowLeft');await expect(page.getByRole('tab',{name:'用户登录'})).toHaveAttribute('aria-selected','true');
  await page.getByLabel('邮箱地址').fill('qa@huanyu.test');await page.getByLabel('密码',{exact:true}).fill('test-password');await page.getByRole('button',{name:'显示密码',exact:true}).click();await expect(page.locator('#password')).toHaveAttribute('type','text');
  await page.getByText('记住我的邮箱',{exact:true}).click();await page.locator('form .submit-button').click();await expect(page.locator('.toast')).toContainText('尚未连接账户');
  await page.getByRole('button',{name:'隐私政策',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('密码不会持久化');await page.keyboard.press('Escape');await expect(page.locator('#auth-title')).toBeVisible();await page.keyboard.press('Escape');await expect(page.locator('.header-login')).toBeFocused();
  console.log('Auth passed');await page.reload({waitUntil:'domcontentloaded'});await page.locator('.header-login').click();await expect(page.getByLabel('邮箱地址')).toHaveValue('qa@huanyu.test');await expect(page.locator('#password')).toHaveValue('');
  await page.keyboard.press('Escape');await page.locator('.install-details summary').click();await page.getByRole('button',{name:'复制安装命令'}).click();await expect(page.getByRole('button',{name:'已复制命令'})).toBeVisible();console.log('Commands copy passed');
  if(run===1){await page.goto(url+'/?preview=oracle-bone',{waitUntil:'domcontentloaded'});await expect(page.locator('#product-preview-oracle-bone')).toBeVisible();await page.screenshot({path:'evidence/next/expanded.png',fullPage:true});await page.locator('.header-auth').click();await page.screenshot({path:'evidence/next/register.png'});}
  expect(errors).toEqual([]);checks.push({run,status:'passed'});await context.close();
 }
 const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});const page=await context.newPage();await page.goto(url,{waitUntil:'domcontentloaded'});await page.locator('#product-toggle-oracle-bone').click();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'evidence/next/mobile-expanded.png',fullPage:true});
 // A blocked clipboard must report a failure without claiming success.
 await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:()=>Promise.reject(new Error('denied'))},configurable:true}));await page.getByRole('button',{name:'复制示例'}).first().click();await expect(page.locator('.toast')).toContainText('复制未完成');
 // A failed storage write must preserve the input and show a failure.
 await page.locator('.header-login').click();await page.getByLabel('邮箱地址').fill('keep@huanyu.test');await page.locator('#password').fill('password');await page.getByText('记住我的邮箱',{exact:true}).click();await page.evaluate(()=>{Storage.prototype.setItem=()=>{throw new Error('blocked');};});await page.locator('form .submit-button').click();await expect(page.locator('.toast')).toContainText('无法记住邮箱');await expect(page.getByLabel('邮箱地址')).toHaveValue('keep@huanyu.test');await context.close();
 await mkdir('evidence/next',{recursive:true});await writeFile('evidence/next/interaction-report.json',JSON.stringify({checks,mobile:'passed',clipboardFailure:'passed',storageFailure:'passed'},null,2));console.log('3 consecutive desktop runs + mobile, clipboard/storage failure checks passed.');
} finally {await browser.close();}

