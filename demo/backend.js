/* Demonstração online: o backend do Banqueiro roda no próprio navegador sobre sql.js. */
import initSqlJs from 'sql.js/dist/sql-asm.js';
import { configurar } from './shims/sqlite.js';
import { abrir } from '../server/db.js';
import { criarApi, tratarErro } from '../server/api.js';
import { popularDemo } from '../server/lib/demo.js';
import seguranca from '../server/lib/seguranca.js';
import manifesto from './gerado/integridade.json';

window.PAYAX_DEMO = true;
const CHAVE = 'payax.demo.db.v10';

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
 * na última atualização. Restaurações ficam guardadas no próprio banco da demonstração. O teste rápido dos
 * serviços roda enquanto a página estiver aberta; o histórico dos 7 dias anteriores é fictício.
 */
const abertaEm = Date.now();
function lerEstado(chave) { return db.prepare('SELECT valor FROM estado_sistema WHERE chave = ?').get(chave)?.valor ?? null; }
function gravarEstado(chave, valor) { db.prepare('INSERT INTO estado_sistema (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor').run(chave, valor); }

const fonteDemo = {
  descricao: `fotografia do código de ${manifesto.gerado_em.slice(0, 10)}`,
  listar() {
    const mudancas = JSON.parse(lerEstado('demo_restauracoes') ?? '{}');
    const mapa = new Map(manifesto.atual.map((f) => [f.caminho, f]));
    for (const [c, f] of Object.entries(mudancas)) { if (f === null) mapa.delete(c); else mapa.set(c, f); }
    return [...mapa.values()];
  },
  restaurar(caminho, base) {
    const mudancas = JSON.parse(lerEstado('demo_restauracoes') ?? '{}');
    mudancas[caminho] = base === null ? null : { caminho, hash: base.hash, tamanho: base.tamanho, conteudo: base.conteudo };
    gravarEstado('demo_restauracoes', JSON.stringify(mudancas));
    return base === null ? 'quarentena' : 'restaurado';
  },
};

/** Histórico fictício de 7 dias (um teste por hora), com alguns incidentes, para a página de status. */
function historicoDemo() {
  if (db.prepare('SELECT COUNT(*) AS n FROM monitor_servicos').get().n) return;
  const DET = { banqueiro: '4 funções respondendo', internet_banking: '5 funções respondendo', site: 'Arquivos presentes', api: 'Respondendo',
    banco_dados: 'Íntegro', bradesco: 'Modo simulador', antifraude: 'Análise em dia', backup: 'Último há 3 h' };
  const INC = [
    { servico: 'site', de: 122, ate: 121, status: 'fora', detalhe: 'Com falha: Site institucional (Arquivo ausente: public/site/index.html) — exemplo da demonstração' },
    { servico: 'bradesco', de: 75, ate: 73, status: 'degradado', detalhe: '3 PIX com falha nas últimas 24 h — exemplo da demonstração' },
    { servico: 'api', de: 50, ate: 49, status: 'degradado', detalhe: '4 erro(s) do servidor na última hora — exemplo da demonstração' },
    { servico: 'internet_banking', de: 30, ate: 30, status: 'fora', detalhe: 'Com falha: Teclado virtual (login do cliente) (Teclado gerado com pares inválidos.) — exemplo da demonstração' },
    { servico: 'backup', de: 6, ate: 0, status: 'degradado', detalhe: 'Último há 30 h — exemplo da demonstração' },
  ];
  const ins = db.prepare("INSERT INTO monitor_servicos (servico, status, ms, detalhe, funcoes, criado_em) VALUES (?, ?, ?, ?, '[]', datetime('now', ?))");
  for (let h = 168; h >= 1; h--) {
    for (const servico of Object.keys(DET)) {
      const inc = INC.find((i) => i.servico === servico && h <= i.de && h >= i.ate);
      ins.run(servico, inc ? inc.status : 'ok', 1 + ((h * 7 + servico.length) % 9), inc ? inc.detalhe : DET[servico], `-${h} hours`);
    }
  }
  gravarEstado('ultimo_backup', new Date(Date.now() - 30 * 3600_000).toISOString());
}

function iniciarSeguranca() {
  seguranca.configurar({
    fonte: fonteDemo,
    fazerBackup: () => ({ arquivo: 'cópia guardada no navegador (demonstração)', tamanho: db.export().length }),
    coletarServidor: () => ({ ambiente: 'demonstracao', ativo_ha_s: Math.round((Date.now() - abertaEm) / 1000) }),
  });
  const vazio = db.prepare('SELECT COUNT(*) AS n FROM integridade_base').get().n === 0;
  if (vazio) {
    const ins = db.prepare("INSERT INTO integridade_base (caminho, hash, tamanho, conteudo, aprovado_em) VALUES (?, ?, ?, ?, datetime('now', '-1 day'))");
    for (const f of manifesto.anterior) ins.run(f.caminho, f.hash, f.tamanho, f.conteudo);
  }
  historicoDemo();
  const ultima = db.prepare("SELECT (julianday('now') - julianday(MAX(criado_em))) * 24 * 60 AS min FROM verificacoes_seguranca").get().min;
  if (ultima === null || ultima >= seguranca.estado.intervaloMin) {
    try { seguranca.executar(db, { origem: vazio ? 'inicial' : 'agendada' }); salvar(); } catch (err) { console.warn('Verificação de segurança:', err); }
  } else {
    try { seguranca.pulsar(db); salvar(); } catch (err) { console.warn('Monitoramento dos serviços:', err); }
  }
  clearInterval(iniciarSeguranca.timer);
  iniciarSeguranca.timer = setInterval(() => { try { seguranca.executar(db); salvar(); } catch { /* tenta de novo na próxima hora */ } }, seguranca.estado.intervaloMin * 60_000);
  clearInterval(iniciarSeguranca.pulso);
  iniciarSeguranca.pulso = setInterval(() => { try { seguranca.pulsar(db); salvar(); } catch { /* tenta de novo no próximo teste */ } }, seguranca.estado.pulsoMin * 60_000);
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

