import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.mjs';
import { openStore } from '../server/store.mjs';
import { hashPassword } from '../server/auth.mjs';
import { validateConfig } from '../server/validation.mjs';
import { seed } from '../server/seed.mjs';

test('validação bloqueia links executáveis, preço inválido e IDs repetidos',()=>{
  const config=structuredClone(seed);config.contact.portalUrl='javascript:alert(1)';assert.throws(()=>validateConfig(config));
  config.contact.portalUrl='';config.plans[0].price=-1;assert.throws(()=>validateConfig(config));
  config.plans[0].price=null;config.plans[1].id=config.plans[0].id;assert.throws(()=>validateConfig(config));
  assert.equal(validateConfig(seed).plans[0].price,null);
});

test('fluxo real: autenticação, rascunho, publicação, upload, cobertura, leads e persistência',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'lk-tech-test-'));
  const app=createApp({dataDir:directory,production:false});
  const password='test-only-password-2026';
  app.store.db.prepare('INSERT INTO admins(email,password_hash,created_at) VALUES(?,?,?)').run('teste@example.com',await hashPassword(password),new Date().toISOString());
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;let cookie='',csrf='';
  async function call(path,method='GET',data,extra={}){const headers={...(data!==undefined?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...extra};const response=await fetch(base+path,{method,headers,...(data!==undefined?{body:JSON.stringify(data)}:{})});const type=response.headers.get('content-type')||'';const payload=type.includes('json')?await response.json():await response.text();return {response,payload};}
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));app.store.db.close();await rm(directory,{recursive:true,force:true});});
  assert.equal((await call('/api/admin/content')).response.status,401);
  assert.equal((await call('/data/site.sqlite')).response.status,404);
  assert.equal((await call('/.env')).response.status,404);
  assert.equal((await call('/api/admin/login','POST',{email:'teste@example.com',password:'errada'})).response.status,401);
  const login=await call('/api/admin/login','POST',{email:'teste@example.com',password});assert.equal(login.response.status,200);cookie=login.response.headers.get('set-cookie').split(';')[0];csrf=login.payload.csrf;
  assert.match(login.response.headers.get('set-cookie'),/HttpOnly/);assert.match(login.response.headers.get('set-cookie'),/SameSite=Strict/);
  const draft=(await call('/api/admin/content')).payload;let config=draft.config,rev=draft.revision;
  config.plans[0].price=89.9;config.banners[0].title='Título do teste';config.seo.title='LK TECH <Internet> & Teste';config.coverage.ranges=[{name:'Região de teste',start:'01000000',end:'01999999'}];
  assert.equal((await call('/api/admin/content','PUT',{config,revision:rev},{'X-CSRF-Token':'incorreto'})).response.status,403);
  assert.equal((await call('/api/admin/content','PUT',{config,revision:rev},{Origin:'https://outra-origem.example'})).response.status,403);
  const save=await call('/api/admin/content','PUT',{config,revision:rev});assert.equal(save.response.status,200);rev=save.payload.revision;
  assert.equal((await call('/api/site')).payload.config.plans[0].price,null,'salvar rascunho não muda o site');
  assert.equal((await call('/api/admin/preview')).payload.config.plans[0].price,89.9);
  assert.equal((await call('/api/admin/content','PUT',{config,revision:rev-1})).response.status,409);
  assert.equal((await call('/api/admin/publish','POST',{revision:rev})).response.status,200);
  assert.equal((await call('/api/site')).payload.config.plans[0].price,89.9);
  assert.match((await call('/')).payload,/<title>LK TECH &lt;Internet&gt; &amp; Teste<\/title>/);
  assert.equal((await call('/api/coverage','POST',{cep:'01000-001'})).payload.status,'available');
  assert.equal((await call('/api/coverage','POST',{cep:'99999-999'})).payload.status,'manual');
  assert.equal((await call('/api/coverage','POST',{cep:'123'})).response.status,400);
  const lead={name:'Contato de teste',phone:'11999998888',cep:'01000001',plan:'500 MEGA',consent:true};
  assert.equal((await call('/api/leads','POST',{...lead,consent:false})).response.status,400);
  assert.equal((await call('/api/leads','POST',lead)).response.status,201);
  const leads=(await call('/api/admin/leads')).payload;assert.equal(leads.length,1);
  assert.equal((await call('/api/admin/leads/'+leads[0].id,'PATCH',{status:'concluido'})).response.status,200);
  assert.match((await call('/api/admin/leads.csv')).payload,/Contato de teste/);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=','base64');
  const uploaded=await fetch(base+'/api/admin/media',{method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'image/png'},body:png});assert.equal(uploaded.status,201);const uploadedData=await uploaded.json();assert.equal((await fetch(base+uploadedData.url)).status,200);
  const svg=await fetch(base+'/api/admin/media',{method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'image/svg+xml'},body:'<svg><script>alert(1)</script></svg>'});assert.equal(svg.status,400);
  assert.equal((await call('/api/admin/history')).payload.length,1);
  const other=openStore(directory);assert.equal(other.read('published').config.plans[0].price,89.9);assert.equal(other.db.prepare('SELECT count(*) AS n FROM leads').get().n,1);other.db.close();
  assert.equal((await call('/api/admin/password','POST',{current:password,password:'new-test-password-2026'})).response.status,200);
  assert.equal((await call('/api/admin/me')).response.status,401);
});

test('arquivos de mídia e referências de entrada existem',async()=>{
  for(const path of ['public/assets/logo.svg','public/assets/favicon.svg','public/assets/hero-casal.png','docs/referencia-layout.png'])assert.ok((await readFile(new URL('../'+path,import.meta.url))).length>0,path);
});

test('painel não consegue entortar o layout: limites, linhas, quantidade, preço e cores', async () => {
  const { validateConfig } = await import('../server/validation.mjs');
  const { seed } = await import('../server/seed.mjs');
  const { LIMITES, QUANTIDADE, CORES } = await import('../public/limites.js');
  const base = () => structuredClone(seed);
  assert.doesNotThrow(() => validateConfig(base()), 'o conteúdo inicial respeita os limites');
  const recusa = (alterar, trecho) => { const c = base(); alterar(c); assert.throws(() => validateConfig(c), e => e.status === 400 && (!trecho || e.message.includes(trecho))); };
  recusa(c => { c.banners[0].title = 'x'.repeat(LIMITES['banners.title'] + 1); }, 'caracteres');
  recusa(c => { c.plans[0].name = 'x'.repeat(LIMITES['plans.name'] + 1); }, 'caracteres');
  recusa(c => { c.plans[0].button = 'x'.repeat(LIMITES['plans.button'] + 1); });
  recusa(c => { c.plans[0].features = Array(QUANTIDADE.features + 1).fill('Wi-Fi'); });
  recusa(c => { c.plans[0].price = 10000; }, 'Preço');
  recusa(c => { c.services.title = 'Uma\nDuas\nTrês'; }, 'linhas');
  recusa(c => { c.banners = Array(QUANTIDADE.banners + 1).fill(0).map((_, i) => ({ ...seed.banners[0], id: 'b' + i })); });
  const c = base(); c.brand.accent = '#00ff00'; c.brand.background = '#ffffff'; c.banners[0].title = 'Conecte\n   o   seu'; c.banners[0].imagePosition = '900% 50%';
  const r = validateConfig(c);
  assert.deepEqual([r.brand.accent, r.brand.background], [CORES.accent, CORES.background], 'cores ficam fixas');
  assert.equal(r.banners[0].title, 'Conecte o seu', 'campos de uma linha não guardam quebras nem espaços extras');
  assert.equal(r.banners[0].imagePosition, '65% 50%');
  assert.equal(validateConfig({ ...base(), services: { ...seed.services, title: 'Mais perto.\nMais simples.' } }).services.title, 'Mais perto.\nMais simples.');
});
