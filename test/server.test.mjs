import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createApp } from '../server.mjs';

const credentials = { login: 'test.admin', password: 'Only-a-temporary-test-password-42' };
const payload = () => ({ name: 'Тестовый клиент', contact: 'test@example.com', company: 'Тестовая компания', budget: '100 000–300 000 ₽', recipient: 'С менеджером', task: 'Создать сайт и подключить CRM для обработки обращений.', services: ['website', 'crm'], website: '' });
async function start(dbPath) {
  const server = createApp({ dbPath }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method='GET', body, cookie, headers={} }={}) => {
    const response = await fetch(base + path, { method, headers: { Origin: base, 'Content-Type': 'application/json', ...(cookie?{Cookie:cookie}:{}), ...headers }, ...(body!==undefined?{body:JSON.stringify(body)}:{}) });
    const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data, headers: response.headers, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const stop=async()=>{server.closeIdleConnections();await new Promise(resolve=>server.close(resolve))};
  return { call, stop, base };
}

test('DMD: complete request lifecycle and access boundaries', async t => {
  const folder=mkdtempSync(join(tmpdir(),'dmd-test-')),dbPath=join(folder,'requests.sqlite');
  let app=await start(dbPath),cookie,id,version;
  t.after(async()=>{await app.stop();rmSync(folder,{recursive:true,force:true})});
  await t.test('public pages load, six services remain, private files cannot be served', async()=>{
    const home=await app.call('/');assert.equal(home.status,200);assert.match(home.headers.get('content-security-policy'),/script-src 'sha256-/);
    assert.equal((home.data.match(/\{id:'/g)||[]).length,6);
    for(const removed of ['AI-менеджер для клиентов','BI и аналитика данных','IT-отдел на аутсорсе','Голосовой AI и анализ звонков'])assert.ok(!home.data.includes(removed));
    assert.ok(!home.data.includes('Скопировать обращение'));assert.ok(home.data.includes('Отправить обращение'));
    assert.equal((await app.call('/admin')).status,200);
    for(const path of ['/server.mjs','/data/dmd.sqlite','/.git/config'])assert.equal((await app.call(path)).status,404);
    assert.equal((await app.call('/api/admin/requests')).status,401);
  });
  await t.test('server validates fields, enum values and removed services',async()=>{
    for(const change of [{name:''},{contact:'123'},{contact:'((((((((('},{task:'x'},{services:['assistant']},{services:['__proto__']},{budget:'untrusted'},{recipient:'someone'},{website:'spam'}]){
      const result=await app.call('/api/requests',{method:'POST',body:{...payload(),...change},headers:{'Idempotency-Key':randomUUID()}});assert.equal(result.status,400,JSON.stringify(change));
    }
    assert.equal((await app.call('/api/requests',{method:'POST',body:payload()})).status,400);
  });
  await t.test('cross-origin writes and unexpected Host headers are rejected',async()=>{
    assert.equal((await app.call('/api/requests',{method:'POST',body:payload(),headers:{Origin:'https://other.example','Idempotency-Key':randomUUID()}})).status,403);
    assert.equal((await app.call('/api/admin/setup',{method:'POST',body:credentials,headers:{Origin:'null'}})).status,403);
    const status=await new Promise((resolve,reject)=>{const req=httpRequest(app.base+'/api/health',{headers:{Host:'other.example'}},res=>{res.resume();resolve(res.statusCode)});req.on('error',reject);req.end()});assert.equal(status,403);
  });
  await t.test('submission persists once, retries deduplicate, key reuse with changes conflicts',async()=>{
    const key=randomUUID();const first=await app.call('/api/requests',{method:'POST',body:payload(),headers:{'Idempotency-Key':key}});
    assert.equal(first.status,201);assert.equal(first.data.received,true);id=first.data.id;
    const retry=await app.call('/api/requests',{method:'POST',body:payload(),headers:{'Idempotency-Key':key}});assert.equal(retry.status,200);assert.equal(retry.data.id,id);
    assert.equal((await app.call('/api/requests',{method:'POST',body:{...payload(),task:'Другая задача для этой же формы.'},headers:{'Idempotency-Key':key}})).status,409);
  });
  await t.test('one-time setup creates account; login and cookies protect admin data',async()=>{
    assert.equal((await app.call('/api/admin/session')).data.setupRequired,true);
    const setup=await app.call('/api/admin/setup',{method:'POST',body:credentials});assert.equal(setup.status,200);cookie=setup.cookie;
    assert.match(setup.headers.get('set-cookie'),/HttpOnly/);assert.match(setup.headers.get('set-cookie'),/SameSite=Strict/);
    assert.equal((await app.call('/api/admin/setup',{method:'POST',body:credentials})).status,409);
    assert.equal((await app.call('/api/admin/login',{method:'POST',body:{...credentials,password:'incorrect'}})).status,401);
    assert.equal((await app.call('/api/admin/requests',{cookie:'dmd_session='+ '0'.repeat(64)})).status,401);
    const list=await app.call('/api/admin/requests',{cookie});assert.equal(list.status,200);assert.equal(list.data.total,1);
    const item=list.data.items[0];assert.equal(item.id,id);assert.equal(item.contact,payload().contact);assert.equal(item.services[0].title,'CRM и автоматизация продаж');version=item.version;
    assert.equal((await app.call('/api/admin/session',{cookie})).data.authenticated,true);
  });
  await t.test('status updates persist with optimistic locking and filters',async()=>{
    assert.equal((await app.call('/api/admin/requests/'+id,{method:'PATCH',body:{status:'done',version}})).status,401);
    const updated=await app.call('/api/admin/requests/'+id,{method:'PATCH',cookie,body:{status:'in_progress',version}});assert.equal(updated.status,200);assert.equal(updated.data.version,2);
    assert.equal((await app.call('/api/admin/requests/'+id,{method:'PATCH',cookie,body:{status:'done',version}})).status,409);
    assert.equal((await app.call('/api/admin/requests?status=new',{cookie})).data.total,0);
    assert.equal((await app.call('/api/admin/requests?status=in_progress',{cookie})).data.total,1);
    assert.equal((await app.call('/api/admin/requests?q='+encodeURIComponent('ТЕСТОВЫЙ КЛИЕНТ'),{cookie})).data.total,1);
    assert.equal((await app.call('/api/admin/requests?q='+encodeURIComponent("' OR 1=1 --"),{cookie})).data.total,0);
    assert.equal((await app.call('/api/admin/requests?page=-1',{cookie})).status,400);
  });
  await t.test('database and admin survive restart; logout invalidates session',async()=>{
    await app.stop();app=await start(dbPath);
    assert.equal((await app.call('/api/admin/session')).data.setupRequired,false);
    const login=await app.call('/api/admin/login',{method:'POST',body:credentials});assert.equal(login.status,200);cookie=login.cookie;
    const list=await app.call('/api/admin/requests',{cookie});assert.equal(list.data.total,1);assert.equal(list.data.items[0].status,'in_progress');
    assert.equal((await app.call('/api/admin/logout',{method:'POST',cookie,body:{}})).status,200);
    assert.equal((await app.call('/api/admin/requests',{cookie})).status,401);
  });
  await t.test('literal markup remains data; all status values work',async()=>{
    const login=await app.call('/api/admin/login',{method:'POST',body:credentials});cookie=login.cookie;
    const input={...payload(),name:'<script>example</script>',task:'<img src=x onerror=alert(1)> — текст клиента',services:[]};
    assert.equal((await app.call('/api/requests',{method:'POST',body:input,headers:{'Idempotency-Key':randomUUID()}})).status,201);
    const list=await app.call('/api/admin/requests',{cookie});const item=list.data.items.find(x=>x.name===input.name);assert.equal(item.task,input.task);
    for(const status of ['done','archived','new']){const result=await app.call('/api/admin/requests/'+item.id,{method:'PATCH',cookie,body:{status,version:item.version}});assert.equal(result.status,200);item.version=result.data.version;}
  });
});

test('login brute-force attempts are limited',async t=>{
  const app=await start(':memory:');t.after(app.stop);
  for(let i=0;i<12;i++)assert.equal((await app.call('/api/admin/login',{method:'POST',body:credentials})).status,401);
  assert.equal((await app.call('/api/admin/login',{method:'POST',body:credentials})).status,429);
});
