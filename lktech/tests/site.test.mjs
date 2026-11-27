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
  for(const path of ['public/assets/logo.svg','public/assets/favicon.svg','public/assets/hero-casal.jpg','docs/referencia-layout.png'])assert.ok((await readFile(new URL('../'+path,import.meta.url))).length>0,path);
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
  const c = base(); c.brand.accent = '#00ff00'; c.brand.background = '#ffffff'; c.brand.logo = '/uploads/outro-logo.png'; c.banners[0].title = 'Conecte\n   o   seu'; c.banners[0].imagePosition = '900% 50%';
  const r = validateConfig(c);
  assert.deepEqual([r.brand.accent, r.brand.background], [CORES.accent, CORES.background], 'cores ficam fixas');
  assert.equal(r.brand.logo, '/assets/logo.svg', 'logo da empresa fica fixo');
  assert.equal(r.banners[0].title, 'Conecte o seu', 'campos de uma linha não guardam quebras nem espaços extras');
  assert.equal(r.banners[0].imagePosition, '65% 50%');
  assert.equal(validateConfig({ ...base(), services: { ...seed.services, title: 'Mais perto.\nMais simples.' } }).services.title, 'Mais perto.\nMais simples.');
});

test('domínio oficial: www redireciona, Google recebe endereço oficial e painel fica fora da busca', async () => {
  const { createApp } = await import('../server/index.mjs');
  const { mkdtemp, rm } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'lk-dominio-'));
  const app = createApp({ dataDir: directory, production: false, origin: 'https://lktechprovedor.com.br' });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const http = await import('node:http');
    const pedir = (caminho, host) => new Promise((ok, erro) => http.get(base + caminho, { headers: { Host: host } }, res => { let corpo = ''; res.on('data', d => corpo += d); res.on('end', () => ok({ status: res.statusCode, location: res.headers.location, corpo })); }).on('error', erro));
    const www = await pedir('/?x=1', 'www.lktechprovedor.com.br');
    assert.equal(www.status, 301); assert.equal(www.location, 'https://lktechprovedor.com.br/?x=1');
    const outro = await pedir('/', 'outrosite.com.br'); assert.equal(outro.status, 200, 'só o www do próprio domínio é redirecionado');
    const html = (await pedir('/', 'lktechprovedor.com.br')).corpo;
    assert.match(html, /<link rel="canonical" href="https:\/\/lktechprovedor\.com\.br\/">/);
    assert.match(html, /og:image" content="https:\/\/lktechprovedor\.com\.br\/assets\/hero-casal\.jpg"/);
    const robots = await (await fetch(base + '/robots.txt')).text();
    assert.match(robots, /Disallow: \/admin/); assert.match(robots, /Sitemap: https:\/\/lktechprovedor\.com\.br\/sitemap\.xml/);
    assert.match(await (await fetch(base + '/sitemap.xml')).text(), /<loc>https:\/\/lktechprovedor\.com\.br\/<\/loc>/);
  } finally { await new Promise(r => app.server.close(r)); app.store?.close?.(); await rm(directory, { recursive: true, force: true }); }
});

test('conteúdo antigo fora das regras não derruba o site; publicar valida; restaurar ajusta; contatos podem ser excluídos', async () => {
  const { createApp } = await import('../server/index.mjs');
  const { hashPassword } = await import('../server/auth.mjs');
  const { mkdtemp, rm } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'lk-antigo-'));
  const app = createApp({ dataDir: directory, production: false });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    // Conteúdo gravado por uma versão antiga: texto enorme, cores e logo trocados, perguntas ausentes.
    const antigo = JSON.parse(app.store.db.prepare("SELECT body FROM documents WHERE kind='published'").get().body);
    antigo.banners[0].title = 'T'.repeat(200); antigo.brand.accent = '#00ff00'; antigo.brand.logo = 'https://exemplo.com/logo.png'; delete antigo.faqs;
    for (const kind of ['published', 'draft']) app.store.db.prepare('UPDATE documents SET body=? WHERE kind=?').run(JSON.stringify(antigo), kind);
    app.store.db.prepare('INSERT INTO history(body,created_at,admin_id) VALUES(?,?,NULL)').run(JSON.stringify(antigo), new Date().toISOString());
    const site = (await (await fetch(base + '/api/site')).json()).config;
    assert.equal(site.banners[0].title.length, 24, 'texto antigo é encurtado para caber');
    assert.deepEqual(site.faqs, [], 'campo ausente é completado');
    assert.equal(site.brand.accent, '#ff9300'); assert.equal(site.brand.logo, '/assets/logo.svg');

    app.store.db.prepare('INSERT INTO admins(email,password_hash,created_at) VALUES(?,?,?)').run('a@exemplo.com', await hashPassword('SenhaDeTeste12345'), new Date().toISOString());
    const login = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ email: 'a@exemplo.com', password: 'SenhaDeTeste12345' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0], { csrf } = await login.json();
    const admin = (caminho, method = 'GET', dados) => fetch(base + '/api/admin/' + caminho, { method, headers: { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: base, ...(dados ? { 'Content-Type': 'application/json' } : {}) }, ...(dados ? { body: JSON.stringify(dados) } : {}) });
    const rev = (await (await admin('content')).json()).revision;
    const pub = await admin('publish', 'POST', { revision: rev });
    assert.equal(pub.status, 400, 'rascunho fora das regras não vai ao ar');
    assert.match((await pub.json()).error, /caracteres/);
    const historico = (await (await admin('history')).json())[0].id;
    const restaurado = await admin('restore', 'POST', { id: historico, revision: rev });
    assert.equal(restaurado.status, 200, 'versão antiga é ajustada ao restaurar');
    const novoRev = (await restaurado.json()).revision;
    assert.equal((await admin('publish', 'POST', { revision: novoRev })).status, 200, 'depois de ajustada, publica normalmente');

    app.store.db.prepare("INSERT INTO leads(name,phone,cep,plan,created_at) VALUES('Maria','11999999999','','',?)").run(new Date().toISOString());
    const id = app.store.db.prepare('SELECT id FROM leads').get().id;
    assert.equal((await admin('leads/999999', 'PATCH', { status: 'concluido' })).status, 404);
    assert.equal((await admin('leads/' + id, 'DELETE')).status, 200);
    assert.equal(app.store.db.prepare('SELECT COUNT(*) n FROM leads').get().n, 0, 'contato excluído de verdade');

    const pagina404 = await fetch(base + '/pagina-que-nao-existe');
    assert.equal(pagina404.status, 404); assert.match(await pagina404.text(), /Página não encontrada/);
    const js = await fetch(base + '/site.js'); const etag = js.headers.get('etag');
    assert.equal(js.headers.get('cache-control'), 'no-cache');
    assert.equal((await fetch(base + '/site.js', { headers: { 'If-None-Match': etag } })).status, 304, 'arquivo igual não é baixado de novo');
  } finally { await new Promise(r => app.server.close(r)); await rm(directory, { recursive: true, force: true }); }
});

test('segurança: ninguém tranca o administrador, sessão renova, corpo inválido dá 400, "$" não quebra a página, CSV em português', async () => {
  const { createApp } = await import('../server/index.mjs');
  const { hashPassword } = await import('../server/auth.mjs');
  const { mkdtemp, rm } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'lk-seg-'));
  const antes = process.env.TRUST_PROXY; process.env.TRUST_PROXY = 'true';
  const app = createApp({ dataDir: directory, production: false });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    app.store.db.prepare('INSERT INTO admins(email,password_hash,created_at) VALUES(?,?,?)').run('dono@exemplo.com', await hashPassword('SenhaDoDono12345'), new Date().toISOString());
    const entrar = (senha, ipOrigem) => fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-Forwarded-For': ipOrigem }, body: JSON.stringify({ email: 'dono@exemplo.com', password: senha }) });
    // 10 senhas erradas, cada uma de um endereço diferente
    for (let i = 0; i < 10; i++) assert.equal((await entrar('errada', `9.9.9.${i}`)).status, 401);
    const dono = await entrar('SenhaDoDono12345', '8.8.8.8');
    assert.equal(dono.status, 200, 'o dono ainda consegue entrar');
    // 10 erros do mesmo endereço bloqueiam só esse endereço
    for (let i = 0; i < 10; i++) await entrar('errada', '7.7.7.7');
    assert.equal((await entrar('SenhaDoDono12345', '7.7.7.7')).status, 429);

    const cookie = dono.headers.get('set-cookie').split(';')[0], { csrf } = await dono.json();
    assert.match(dono.headers.get('set-cookie'), /Path=\/api\/admin/);
    // sessão perto do fim é renovada ao usar o painel
    app.store.db.prepare('UPDATE sessions SET expires_at=?').run(Date.now() + 60000);
    const uso = await fetch(base + '/api/admin/me', { headers: { Cookie: cookie } });
    assert.equal(uso.status, 200); assert.match(uso.headers.get('set-cookie') || '', /lk_session=/, 'cookie renovado');
    assert.ok(app.store.db.prepare('SELECT expires_at FROM sessions').get().expires_at > Date.now() + 3600000);

    // corpo que não é objeto
    assert.equal((await fetch(base + '/api/leads', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: 'null' })).status, 400);
    const admin = (caminho, method = 'GET', dados) => fetch(base + '/api/admin/' + caminho, { method, headers: { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: base, ...(dados ? { 'Content-Type': 'application/json' } : {}) }, ...(dados ? { body: JSON.stringify(dados) } : {}) });
    const rascunho = await (await admin('content')).json();
    assert.equal((await admin('content', 'PUT', { config: { ...rascunho.config, banners: [null] }, revision: rascunho.revision })).status, 400);

    // "$" no título e na descrição não bagunça o HTML
    const c = rascunho.config; c.seo.title = "Plano $` top $&"; c.seo.description = "Internet $' fim";
    const salvo = await (await admin('content', 'PUT', { config: c, revision: rascunho.revision })).json();
    assert.equal((await admin('publish', 'POST', { revision: salvo.revision })).status, 200);
    const html = await (await fetch(base + '/')).text();
    assert.match(html, /<title>Plano \$` top \$&amp;<\/title>/); assert.match(html, /content="Internet \$&#39; fim"/);
    assert.equal((html.match(/<meta name="description"/g) || []).length, 1);

    // CSV com data de Brasília e situação por extenso
    app.store.db.prepare("INSERT INTO leads(name,phone,cep,plan,status,created_at) VALUES('Ana','11999999999','','','em_atendimento','2026-11-27T15:00:00.000Z')").run();
    const csv = await (await admin('leads.csv')).text();
    assert.match(csv, /Em atendimento/); assert.match(csv, /27\/11\/2026, 12:00:00/);
    assert.deepEqual(await (await admin('leads/resumo')).json(), { total: 1, novos: 0 });
  } finally {
    if (antes === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = antes;
    await new Promise(r => app.server.close(r)); await rm(directory, { recursive: true, force: true });
  }
});

test('campanhas prontas (pasta conteudo/) respeitam as regras do painel e as imagens existem', async () => {
  const { validateConfig } = await import('../server/validation.mjs');
  const { seed } = await import('../server/seed.mjs');
  const { readdir, readFile, access } = await import('node:fs/promises');
  const arquivos = (await readdir(new URL('../conteudo/', import.meta.url))).filter(n => n.endsWith('.json'));
  assert.ok(arquivos.length > 0);
  for (const nome of arquivos) {
    const campanha = JSON.parse(await readFile(new URL('../conteudo/' + nome, import.meta.url), 'utf8'));
    const config = structuredClone(seed);
    for (const [k, v] of Object.entries(campanha)) if (!k.startsWith('_')) config[k] = v;
    const r = validateConfig(config);
    for (const b of r.banners) for (const img of [b.image, b.mobileImage].filter(v => v.startsWith('/assets/'))) await access(new URL('../public' + img, import.meta.url));
    for (const p of r.plans) for (const app of p.apps) if (app.logo.startsWith('/assets/')) await access(new URL('../public' + app.logo, import.meta.url));
  }
});

test('aplicativos dos planos: até 8, nome curto e logo só por endereço seguro', async () => {
  const { validateConfig, ajustarAosLimites } = await import('../server/validation.mjs');
  const { seed } = await import('../server/seed.mjs');
  const com = apps => { const c = structuredClone(seed); c.plans[0].apps = apps; return c; };
  assert.equal(validateConfig(com([{ nome: 'SKY+', logo: '/uploads/0f8fad5b-d9cb-469f-a165-70867728950e.png' }, { nome: 'Globo', logo: '' }])).plans[0].apps.length, 2);
  assert.throws(() => validateConfig(com(Array(9).fill({ nome: 'App', logo: '' }))), /no máximo 8/);
  assert.throws(() => validateConfig(com([{ nome: 'Nome de aplicativo enorme', logo: '' }])), /caracteres/);
  assert.throws(() => validateConfig(com([{ nome: 'App', logo: 'javascript:alert(1)' }])));
  const ajustado = ajustarAosLimites(com([{ nome: 'App', logo: 'javascript:alert(1)' }, null, { nome: '' }]));
  assert.deepEqual(ajustado.plans[0].apps, [{ nome: 'App', logo: '' }], 'conteúdo antigo: logo perigoso e itens inválidos são descartados');
});
