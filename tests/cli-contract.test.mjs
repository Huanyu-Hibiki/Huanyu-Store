import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// 跨仓库契约闸门（quality M3）：服务端 semver 判定与版本比较必须与 CLI 源码逐边值同判。
// CLI 仓库只读、路径经 HY_CLI_SRC 提供或缺省探测相邻目录；探测不到按 skip 处理（CI 无 CLI 仓库不假红）。
import { isVersion, compareVersions } from '../lib/publish-core.mjs';

const storeRoot=fileURLToPath(new URL('..',import.meta.url));
const candidates=[process.env.HY_CLI_SRC,path.resolve(storeRoot,'../Huanyu-CLI/src/skills.js')].filter(Boolean);
const cliPath=candidates.find((candidate)=>existsSync(candidate));
const skip=cliPath?false:`未找到 CLI 仓库 src/skills.js（探测：${candidates.join('、')}；可用 HY_CLI_SRC 指定），跳过跨仓库契约闸门`;

test('semver/compare 与 CLI skills.js 逐边值同判（CLI 侧漂移即红）',{skip},async()=>{
  const cli=await import(pathToFileURL(cliPath).href);
  // 边值集：合法三段/前导零/预发布/构建元数据/v 前缀/2 段/4 段/空与非字符串
  const versions=['0.0.0','1.0.0','0.10.3','10.20.30','01.0.0','0.01.0','0.0.01','1.0.0-rc1',
    '1.0.0+build.1','v1.0.0','1.0','1.0.0.0','','abc','1.0.0-rc.1+meta',null,undefined,42];
  for (const version of versions){
    assert.equal(isVersion(version),cli.isVersion(version),`isVersion(${JSON.stringify(version)}) 与 CLI 不同判`);
  }
  // 排序同判（比较器只对合法 semver 约定调用；0.10.0 vs 0.9.0 的文本序陷阱在内）
  const pairs=[['0.10.0','0.9.0'],['0.9.0','0.10.0'],['1.0.0','1.0.0'],['2.0.0','10.0.0'],
    ['0.0.1','0.0.2'],['0.0.2','0.0.1'],['1.2.3','1.3.0']];
  for (const [a,b] of pairs){
    assert.equal(compareVersions(a,b),cli.compare(a,b),`compareVersions(${a}, ${b}) 与 CLI 不同判`);
  }
});
