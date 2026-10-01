/* Demonstração online: o backend do Banqueiro roda no próprio navegador sobre sql.js. */
import initSqlJs from 'sql.js/dist/sql-asm.js';
import { configurar } from './shims/sqlite.js';
import { abrir } from '../server/db.js';
import { criarApi, tratarErro } from '../server/api.js';
import { popularDemo } from '../server/lib/demo.js';
import seguranca from '../server/lib/seguranca.js';
import manifesto from './gerado/integridade.json';

window.PAYAX_DEMO = true;
const CHAVE = 'payax.demo.db.v9';

function carregarSalvo() {
  try {
    const b64 = localStorage.getItem(CHAVE);
    if (!b64) return null;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch { return null; }
}

let db;
let api;
let sqlJs;
const pronto = initSqlJs().then((SQL) => {
  sqlJs = SQL;
  configurar(SQL, carregarSalvo());
  try {
    db = abrir(':memory:');
  } catch {
    configurar(SQL, null);
    db = abrir(':memory:');
  }
  if (db.prepare('SELECT COUNT(*) AS n FROM clientes').get().n === 0) popularDemo(db);
  api = criarApi(db);
  iniciarSeguranca();
});

// Outra aba (ex.: Banqueiro e Internet Banking abertos ao mesmo tempo) salvou: carrega os dados dela,
// para as duas abas trabalharem sobre o mesmo banco de demonstração.
window.addEventListener('storage', (e) => {
  if (e.key !== CHAVE || !e.newValue) return;
  pronto.then(() => {
    const bytes = carregarSalvo();
    if (!bytes) return;
    try { db.close?.(); } catch { /* ignora */ }
    configurar(sqlJs, bytes);
    db = abrir(':memory:');
    api = criarApi(db);
  });
});

/**
 * Monitoramento de segurança na demonstração: a "fonte" é a fotografia do código gerada no build.
 * Um banco novo começa com a versão anterior aprovada, então a primeira verificação mostra o que mudou
 * na última atualização. Depois, verifica de hora em hora enquanto a página estiver aberta.
 */
function iniciarSeguranca() {
  seguranca.configurar({ fonte: { descricao: `fotografia do código de ${manifesto.gerado_em.slice(0, 10)}`, listar: () => manifesto.atual } });
  const vazio = db.prepare('SELECT COUNT(*) AS n FROM integridade_base').get().n === 0;
  if (vazio) {
    const ins = db.prepare("INSERT INTO integridade_base (caminho, hash, tamanho, conteudo, aprovado_em) VALUES (?, ?, ?, ?, datetime('now', '-1 day'))");
    for (const f of manifesto.anterior) ins.run(f.caminho, f.hash, f.tamanho, f.conteudo);
  }
  const ultima = db.prepare("SELECT (julianday('now') - julianday(MAX(criado_em))) * 24 * 60 AS min FROM verificacoes_seguranca").get().min;
  if (ultima === null || ultima >= seguranca.estado.intervaloMin) {
    try { seguranca.executar(db, { origem: vazio ? 'inicial' : 'agendada' }); salvar(); } catch (err) { console.warn('Verificação de segurança:', err); }
  }
  clearInterval(iniciarSeguranca.timer);
  iniciarSeguranca.timer = setInterval(() => { try { seguranca.executar(db); salvar(); } catch { /* tenta de novo na próxima hora */ } }, seguranca.estado.intervaloMin * 60_000);
}

function salvar() {
  try {
    const bytes = db.export();
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    localStorage.setItem(CHAVE, btoa(bin));
  } catch { /* armazenamento indisponível: os dados ficam só nesta aba */ }
}

function despachar(metodo, url, cabecalhos, corpo) {
  return new Promise((resolve) => {
    const headers = {};
    let status = 200;
    const res = {
      status(s) { status = s; return res; },
      set(k, v) { if (typeof k === 'object') Object.assign(headers, k); else headers[k] = v; return res; },
      json(o) { headers['Content-Type'] = 'application/json'; resolve({ status, headers, body: JSON.stringify(o) }); },
      send(s) { resolve({ status, headers, body: s }); },
      end() { resolve({ status, headers, body: null }); },
    };
    const req = {
      method: metodo,
      path: url.pathname.replace(/^.*?\/api(?=\/)/, ''),
      query: Object.fromEntries(url.searchParams),
      body: corpo,
      params: {},
      ip: 'navegador',
      get: (n) => cabecalhos[n.toLowerCase()],
    };
    api(req, res, (err) => tratarErro(err ?? { message: 'Rota não encontrada.' }, res));
  });
}

const fetchOriginal = window.fetch.bind(window);
window.fetch = async (entrada, opcoes = {}) => {
  const url = new URL(typeof entrada === 'string' ? entrada : entrada.url, location.href);
  if (!/\/api\//.test(url.pathname)) return fetchOriginal(entrada, opcoes);
  await pronto;
  const metodo = (opcoes.method || 'GET').toUpperCase();
  const cab = Object.fromEntries(Object.entries(opcoes.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  let corpo;
  try { corpo = opcoes.body ? JSON.parse(opcoes.body) : undefined; } catch {
    return new Response(JSON.stringify({ erro: 'JSON inválido.' }), { status: 400 });
  }
  const r = await despachar(metodo, url, cab, corpo);
  if (metodo !== 'GET' && r.status < 400) salvar();
  return new Response(r.status === 204 ? null : r.body, { status: r.status, headers: r.headers });
};

/** Faixa fixa da demonstração, com atalho para o outro portal e botão de restaurar os dados. */
export function faixaDemo(link, { topo = false } = {}) {
  const el = document.createElement('div');
  el.className = `faixa-demo${topo ? ' topo' : ''}`;
  el.innerHTML = `<span><strong>Demonstração</strong> · dados fictícios no seu navegador</span>
    ${link ? `<a class="btn sm" href="${link.href}">${link.rotulo}</a>` : ''}<button type="button" class="btn sm" id="demo-reset">Restaurar dados</button>`;
  document.body.prepend(el);
  const botao = el.querySelector('#demo-reset');
  let armado = false;
  botao.addEventListener('click', () => {
    if (!armado) { armado = true; botao.textContent = 'Clique de novo para confirmar'; setTimeout(() => { armado = false; botao.textContent = 'Restaurar dados'; }, 4000); return; }
    try { localStorage.removeItem(CHAVE); sessionStorage.clear(); } catch { /* ignora */ }
    location.hash = '';
    location.reload();
  });
}

