import http from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openStore } from './store.mjs';
import { sessionFor, createSession, hashPassword, verifyPassword } from './auth.mjs';
import { HttpError, validateConfig, validateLead, ajustarAosLimites } from './validation.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = resolve(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const htmlEscape = value => String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
function json(res, code, value, extra = {}) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }); res.end(JSON.stringify(value)); }
async function rawBody(req, max) {
  if (Number(req.headers['content-length']) > max) { req.resume(); throw new HttpError(413, 'Arquivo ou conteúdo muito grande.'); }
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw new HttpError(413, 'Arquivo ou conteúdo muito grande.'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Envie conteúdo JSON.');
  const bytes = await rawBody(req, 256 * 1024);
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new HttpError(400, 'Conteúdo JSON inválido.'); }
}
function imageKind(bytes) {
  if (bytes.length > 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(16) <= 10000 && bytes.readUInt32BE(20) > 0 && bytes.readUInt32BE(20) <= 10000) return '.png';
  if (bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217) return '.jpg';
  if (bytes.length > 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  throw new HttpError(400, 'Envie uma imagem PNG, JPG ou WebP válida (até 8 MB).');
}

export function createApp(options = {}) {
  const store = openStore(options.dataDir);
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const origin = options.origin ?? process.env.PUBLIC_ORIGIN ?? '';
  if (production && !/^https:\/\/[^/]+$/.test(origin)) throw new Error('Configure PUBLIC_ORIGIN com o domínio HTTPS, sem barra final.');
  const hours = Math.min(24, Math.max(1, Number(process.env.SESSION_HOURS) || 8));
  const cookie = (value, age = hours * 3600) => `lk_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${production ? '; Secure' : ''}`;
  const dummyHash = hashPassword('unused-password-for-constant-cost');
  // IP do visitante. Atrás do Caddy vale o último item do X-Forwarded-For (o que o próprio proxy anotou).
  // Endereços IPv6 são agrupados pela rede /64, para ninguém escapar dos limites trocando de endereço.
  const ip = req => {
    const bruto = (process.env.TRUST_PROXY === 'true' ? String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',').at(-1) : String(req.socket.remoteAddress || '')).trim().slice(0, 100).replace(/^::ffff:/, '');
    if (!bruto.includes(':')) return bruto;
    const [esq, dir = ''] = bruto.split('::'), a = esq ? esq.split(':') : [], b = dir ? dir.split(':') : [];
    const partes = [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b];
    return partes.slice(0, 4).join(':') + '::/64';
  };
  // No máximo 2 conferências de senha ao mesmo tempo: uma enxurrada de logins não trava o site.
  let conferindo = 0; const fila = [];
  const conferirSenha = async (senha, hash) => {
    if (conferindo >= 2) { if (fila.length >= 20) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.'); await new Promise(ok => fila.push(ok)); }
    conferindo++;
    try { return await verifyPassword(senha, hash); } finally { conferindo--; fila.shift()?.(); }
  };
  const publicado = () => { const v = store.read('published'); v.config = ajustarAosLimites(v.config); return v; };
  const rascunho = () => { const v = store.read('draft'); v.config = ajustarAosLimites(v.config); return v; };
  function checkOrigin(req) {
    const source = req.headers.origin;
    const expected = origin || `http://${req.headers.host}`;
    if ((source && source !== expected) || req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Origem não autorizada.');
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-src 'self'; frame-ancestors 'self'; object-src 'none'");
    if (production) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const url = new URL(req.url, 'http://local');
      const path = decodeURIComponent(url.pathname);
      const method = req.method;
      // Domínio único: quem entra por outro nome do mesmo site (ex.: www) vai para o endereço oficial.
      if (origin && ['GET', 'HEAD'].includes(method)) {
        const oficial = new URL(origin).host, pedido = String(req.headers.host || '').toLowerCase();
        if (pedido && pedido !== oficial && pedido.replace(/^www\./, '') === oficial.replace(/^www\./, '')) { res.writeHead(301, { Location: origin + req.url, 'Cache-Control': 'public, max-age=86400' }); return res.end(); }
      }
      if (path === '/robots.txt' && ['GET', 'HEAD'].includes(method)) {
        const corpo = `User-agent: *\nDisallow: /admin\nDisallow: /api/\n${origin ? `Sitemap: ${origin}/sitemap.xml\n` : ''}`;
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }); return res.end(method === 'HEAD' ? undefined : corpo);
      }
      if (path === '/sitemap.xml' && origin && ['GET', 'HEAD'].includes(method)) {
        const corpo = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url></urlset>\n`;
        res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }); return res.end(method === 'HEAD' ? undefined : corpo);
      }
      if (path.startsWith('/api/')) {
        if (!['GET','HEAD'].includes(method)) checkOrigin(req);
        if (path === '/api/health' && method === 'GET') return json(res, 200, { ok: true });
        if (path === '/api/site' && method === 'GET') {
          const value = publicado();
          value.config.banners = value.config.banners.filter(v => v.active);
          value.config.plans = value.config.plans.filter(v => v.active);
          value.config.coverage.ranges = [];
          return json(res, 200, value);
        }
        if (path === '/api/coverage' && method === 'POST') {
          if (!store.limit(`coverage:${ip(req)}`, 40, 600)) throw new HttpError(429, 'Aguarde alguns minutos antes de consultar novamente.');
          const input = await body(req), cep = String(input.cep || '').replace(/\D/g, '');
          if (!/^\d{8}$/.test(cep)) throw new HttpError(400, 'Informe um CEP com 8 dígitos.');
          const { coverage } = publicado().config;
          const range = coverage.ranges.find(v => cep >= v.start && cep <= v.end);
          const status = range ? 'available' : coverage.strict && coverage.ranges.length ? 'unavailable' : 'manual';
          const message = { available: 'Seu CEP está na nossa região de atendimento. Vamos confirmar a viabilidade no seu endereço?', unavailable: 'Ainda não encontramos cobertura para esse CEP. Deixe seu contato para consultar novas possibilidades.', manual: 'Nossa equipe vai confirmar a disponibilidade para o seu endereço. Deixe seu contato para continuar.' }[status];
          return json(res, 200, { status, message });
        }
        if (path === '/api/leads' && method === 'POST') {
          if (!store.limit(`leads:${ip(req)}`, 8, 3600)) throw new HttpError(429, 'Recebemos seus pedidos. Aguarde para enviar novamente.');
          const input = await body(req);
          if (input.website) return json(res, 201, { ok: true });
          const lead = validateLead(input);
          store.db.prepare('INSERT INTO leads(name,phone,cep,plan,created_at) VALUES(?,?,?,?,?)').run(lead.name, lead.phone, lead.cep, lead.plan, new Date().toISOString());
          return json(res, 201, { ok: true, message: 'Recebemos seu pedido. Nossa equipe vai entrar em contato.' });
        }
        if (path === '/api/admin/login' && method === 'POST') {
          if (!store.limit(`login:${ip(req)}`, 10, 900)) throw new HttpError(429, 'Muitas tentativas. Aguarde 15 minutos.');
          const input = await body(req);
          const email = String(input.email || '').trim().toLowerCase();
          const password = String(input.password || '');
          if (email.length > 160 || password.length > 512) throw new HttpError(400, 'Confira seus dados.');
          if (!store.limit(`login-email:${email}`, 10, 900)) throw new HttpError(429, 'Muitas tentativas. Aguarde 15 minutos.');
          const admin = store.db.prepare('SELECT * FROM admins WHERE email=?').get(email);
          const valid = await conferirSenha(password, admin?.password_hash || await dummyHash);
          if (!admin || !valid) throw new HttpError(401, 'E-mail ou senha inválidos.');
          const session = createSession(store, admin.id, hours);
          return json(res, 200, { email, csrf: session.csrf }, { 'Set-Cookie': cookie(session.token) });
        }
        if (path.startsWith('/api/admin/')) {
          const session = sessionFor(store, req);
          if (!session) throw new HttpError(401, 'Entre no painel para continuar.');
          if (!['GET','HEAD'].includes(method) && req.headers['x-csrf-token'] !== session.csrf) throw new HttpError(403, 'Recarregue o painel para continuar.');
          if (path === '/api/admin/me' && method === 'GET') return json(res, 200, { email: session.email, csrf: session.csrf });
          if (path === '/api/admin/logout' && method === 'POST') { store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(session.token_hash); return json(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) }); }
          if (path === '/api/admin/content' && method === 'GET') return json(res, 200, rascunho());
          if (path === '/api/admin/content' && method === 'PUT') { const input = await body(req); return json(res, 200, store.save(validateConfig(input.config), input.revision)); }
          if (path === '/api/admin/publish' && method === 'POST') {
            // Só vai ao ar conteúdo que passa por todas as regras (limites, cores e logo fixos).
            const input = await body(req), conferido = validateConfig(store.read('draft').config);
            return json(res, 200, store.publish(input.revision, session.admin_id, conferido));
          }
          if (path === '/api/admin/preview' && method === 'GET') return json(res, 200, rascunho());
          if (path === '/api/admin/history' && method === 'GET') return json(res, 200, store.db.prepare('SELECT id,created_at FROM history ORDER BY id DESC').all());
          if (path === '/api/admin/restore' && method === 'POST') {
            const input = await body(req), row = store.db.prepare('SELECT body FROM history WHERE id=?').get(Number(input.id));
            if (!row) throw new HttpError(404, 'Versão não encontrada.');
            // Versões antigas são ajustadas aos limites atuais antes de voltar ao rascunho.
            return json(res, 200, store.save(validateConfig(ajustarAosLimites(JSON.parse(row.body))), input.revision));
          }
          if (path === '/api/admin/media' && method === 'POST') {
            if (!store.limit(`media:${session.admin_id}`, 100, 3600)) throw new HttpError(429, 'Aguarde para enviar novas imagens.');
            const bytes = await rawBody(req, 8 * 1024 * 1024), extension = imageKind(bytes), name = randomUUID() + extension;
            await writeFile(resolve(store.directory, 'uploads', name), bytes, { flag: 'wx', mode: 0o600 });
            return json(res, 201, { url: `/uploads/${name}` });
          }
          if (path === '/api/admin/media' && method === 'GET') {
            const { readdir } = await import('node:fs/promises');
            const pasta = resolve(store.directory, 'uploads'), nomes = (await readdir(pasta)).filter(n => /^[a-f0-9-]+\.(png|jpg|webp)$/.test(n));
            const lista = await Promise.all(nomes.map(async n => ({ url: `/uploads/${n}`, quando: (await stat(resolve(pasta, n))).mtimeMs })));
            return json(res, 200, lista.sort((a, b) => b.quando - a.quando).map(({ url }) => ({ url })));
          }
          if (path === '/api/admin/leads' && method === 'GET') return json(res, 200, store.db.prepare('SELECT * FROM leads ORDER BY id DESC LIMIT 1000').all());
          if (/^\/api\/admin\/leads\/\d+$/.test(path) && method === 'PATCH') {
            const input = await body(req);
            if (!['novo','em_atendimento','concluido'].includes(input.status)) throw new HttpError(400, 'Situação inválida.');
            const r = store.db.prepare('UPDATE leads SET status=? WHERE id=?').run(input.status, Number(path.split('/').at(-1)));
            if (!r.changes) throw new HttpError(404, 'Contato não encontrado.');
            return json(res, 200, { ok: true });
          }
          if (/^\/api\/admin\/leads\/\d+$/.test(path) && method === 'DELETE') {
            const r = store.db.prepare('DELETE FROM leads WHERE id=?').run(Number(path.split('/').at(-1)));
            if (!r.changes) throw new HttpError(404, 'Contato não encontrado.');
            return json(res, 200, { ok: true });
          }
          if (path === '/api/admin/leads.csv' && method === 'GET') {
            const quote = v => { let s = String(v ?? ''); if (/^[=+@\-\t\r]/.test(s)) s = "'" + s; return '"' + s.replaceAll('"','""') + '"'; };
            const rows = store.db.prepare('SELECT name,phone,cep,plan,status,created_at FROM leads ORDER BY id DESC').all();
            const csv = '\ufeffNome;Telefone;CEP;Plano;Situação;Data\r\n' + rows.map(r => Object.values(r).map(quote).join(';')).join('\r\n');
            res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="lk-tech-contatos.csv"', 'Cache-Control': 'no-store' }); return res.end(csv);
          }
          if (path === '/api/admin/password' && method === 'POST') {
            const input = await body(req), admin = store.db.prepare('SELECT * FROM admins WHERE id=?').get(session.admin_id);
            if (typeof input.current !== 'string' || input.current.length > 512 || !(await verifyPassword(input.current, admin.password_hash))) throw new HttpError(400, 'Senha atual incorreta.');
            if (typeof input.password !== 'string' || input.password.length < 12 || input.password.length > 512) throw new HttpError(400, 'Use uma senha entre 12 e 512 caracteres.');
            const hash = await hashPassword(input.password);
            store.transaction(() => { store.db.prepare('UPDATE admins SET password_hash=? WHERE id=?').run(hash, session.admin_id); store.db.prepare('DELETE FROM sessions WHERE admin_id=?').run(session.admin_id); });
            return json(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
          }
          throw new HttpError(404, 'Rota não encontrada.');
        }
        throw new HttpError(404, 'Rota não encontrada.');
      }
      if (!['GET','HEAD'].includes(method)) throw new HttpError(405, 'Método não permitido.');
      let file;
      if (path === '/' || path === '/index.html') file = resolve(PUBLIC, 'index.html');
      else if (path === '/admin' || path === '/admin/') file = resolve(PUBLIC, 'admin.html');
      else if (/^\/uploads\/[a-f0-9-]+\.(png|jpg|webp)$/.test(path)) file = resolve(store.directory, 'uploads', path.split('/').at(-1));
      else { file = resolve(PUBLIC, '.' + path); if (!file.startsWith(PUBLIC + '/') || !MIME[extname(file)] || /(^|\/)\./.test(path) || path.includes('\\')) throw new HttpError(404, 'Arquivo não encontrado.'); }
      const meta = await stat(file).catch(() => null);
      if (!meta?.isFile()) throw new HttpError(404, 'Arquivo não encontrado.');
      // JS, CSS e SVG: o navegador sempre confere se mudou (ETag). Depois de uma atualização
      // ninguém fica com um pedaço antigo do site misturado com um novo.
      const ext = extname(file), conferirSempre = ['.js', '.css', '.svg'].includes(ext);
      const etag = `W/"${meta.size.toString(16)}-${Math.floor(meta.mtimeMs).toString(16)}"`;
      if (conferirSempre && req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' }); return res.end(); }
      let bytes = await readFile(file);
      if (file === resolve(PUBLIC, 'index.html')) {
        const config = publicado().config;
        let html = bytes.toString('utf8').replace(/<title>[^<]*<\/title>/, `<title>${htmlEscape(config.seo.title)}</title>`).replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${htmlEscape(config.seo.description)}">`);
        const primeiro = config.banners.find(v => v.active), image = primeiro?.image;
        // Pré-carrega só a foto que a tela vai usar (computador ou celular).
        const preload = !primeiro ? '' : primeiro.mobileImage
          ? `<link rel="preload" as="image" href="${htmlEscape(primeiro.image)}" media="(min-width: 601px)"><link rel="preload" as="image" href="${htmlEscape(primeiro.mobileImage)}" media="(max-width: 600px)">`
          : `<link rel="preload" as="image" href="${htmlEscape(primeiro.image)}">`;
        html = html.replace('<link rel="preload" as="image" href="/assets/hero-casal.jpg">', preload);
        if (origin) {
          const imagem = image ? (image.startsWith('/') ? origin + image : image) : `${origin}/assets/hero-casal.jpg`;
          html = html.replace('</head>', `  <link rel="canonical" href="${origin}/">\n  <meta property="og:type" content="website"><meta property="og:url" content="${origin}/"><meta property="og:site_name" content="LK TECH"><meta property="og:locale" content="pt_BR">\n  <meta property="og:title" content="${htmlEscape(config.seo.title)}"><meta property="og:description" content="${htmlEscape(config.seo.description)}"><meta property="og:image" content="${htmlEscape(imagem)}">\n</head>`);
        }
        bytes = Buffer.from(html);
      }
      const cache = ext === '.html' || path.startsWith('/admin') ? 'no-store' : conferirSempre ? 'no-cache' : path.startsWith('/uploads/') ? 'public, max-age=31536000, immutable' : 'public, max-age=86400';
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': bytes.length, 'Cache-Control': cache, ...(conferirSempre ? { ETag: etag } : {}) });
      res.end(method === 'HEAD' ? undefined : bytes);
    } catch (e) {
      if (!res.headersSent && e.status === 404 && !req.url.startsWith('/api/') && ['GET', 'HEAD'].includes(req.method)) {
        const pagina = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Página não encontrada | LK TECH</title><link rel="icon" href="/assets/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/site.css"></head><body><main class="load-error"><img src="/assets/logo.svg" alt="LK TECH" width="190" height="65"><h1>Página não encontrada.</h1><p>O endereço que você abriu não existe ou mudou.</p><a class="primary" href="/">Ir para o início</a></main></body></html>';
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(req.method === 'HEAD' ? undefined : pagina);
      }
      if (!res.headersSent) json(res, e.status || (e instanceof URIError ? 400 : 500), { error: e.status ? e.message : 'Não foi possível concluir. Tente novamente.' });
      else res.end();
      if (!e.status && !(e instanceof URIError)) console.error('Erro no servidor:', e.message);
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 15000;
  return { server, store };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = (name, fallback) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : fallback; };
  const app = createApp(), port = Number(argument('--port', process.env.PORT || 3000));
  app.server.listen(port, argument('--host', process.env.HOST || '0.0.0.0'), () => console.log(`LK TECH pronta em http://localhost:${port} | Painel: /admin`));
  const close = () => app.server.close(() => { app.store.db.close(); process.exit(0); });
  process.once('SIGTERM', close); process.once('SIGINT', close);
}
