import test from 'node:test';
import assert from 'node:assert/strict';
import {filterSkills,categoriesFor} from '../lib/catalog.mjs';
const base={id:'oracle-bone',title:'内容校准',category:'内容与表达',description:'让表达更具体',keywords:['写作'],listed:true};
test('search matches identifiers, keywords and combined category',()=>{assert.equal(filterSkills([base],' ORACLE-BONE ').length,1);assert.equal(filterSkills([base],'写作','内容与表达').length,1);assert.equal(filterSkills([base],'写作','增长与获客').length,0);});
test('hidden items never appear in search or category choices',()=>{const hidden={...base,id:'hidden',category:'隐藏分类',listed:false};assert.deepEqual(filterSkills([hidden],''),[]);assert.deepEqual(categoriesFor([base,hidden]),['全部','内容与表达']);});
test('catalog supports growth without a fixed product count',()=>{const items=Array.from({length:19},(_,i)=>({...base,id:`skill-${i}`,category:i%2?'增长与获客':'内容与表达'}));assert.equal(filterSkills(items).length,19);assert.equal(filterSkills(items,'','增长与获客').length,9);assert.equal(filterSkills(items,'no-match').length,0);});
