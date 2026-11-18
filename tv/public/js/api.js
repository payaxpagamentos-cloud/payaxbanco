/**
 * Endereço base da API.
 * No navegador, sai de onde este arquivo foi carregado (ex.: '/tv').
 * Dentro dos apps de TV, a interface vai empacotada no aparelho e o servidor fica noutro
 * endereço: aí o app define window.PLAYTV_API antes de carregar o script.
 */
export const BASE = window.PLAYTV_API
  ? String(window.PLAYTV_API).replace(/\/+$/, '')
  : new URL('..', import.meta.url).pathname.replace(/\/$/, '');

/** Transforma um caminho devolvido pelo servidor em endereço completo, quando o app é empacotado. */
export const absoluto = (caminho) => (!caminho || /^https?:/i.test(caminho) || !window.PLAYTV_API
  ? caminho
  : new URL(caminho, window.PLAYTV_API).toString());

const CHAVE_SESSAO = 'playtv.sessao';
const CHAVE_PERFIL = 'playtv.perfil';
let memoria = null;

const guardar = (chave, valor) => { try { localStorage.setItem(chave, JSON.stringify(valor)); } catch { /* sem armazenamento */ } };
const ler = (chave) => { try { return JSON.parse(localStorage.getItem(chave)); } catch { return null; } };

export const sessao = {
  get: () => ler(CHAVE_SESSAO) ?? memoria,
  set(dados) { memoria = dados; guardar(CHAVE_SESSAO, dados); },
  limpar() {
    memoria = null;
    try { localStorage.removeItem(CHAVE_SESSAO); localStorage.removeItem(CHAVE_PERFIL); } catch { /* ignora */ }
  },
};

/** Perfil de visualização escolhido na TV: { id, nome, cor, infantil, chave } (a chave vem do PIN). */
export const perfil = {
  get: () => ler(CHAVE_PERFIL),
  set: (p) => guardar(CHAVE_PERFIL, p),
  limpar() { try { localStorage.removeItem(CHAVE_PERFIL); } catch { /* ignora */ } },
};

export class ErroApi extends Error {
  constructor(mensagem, status, detalhes) {
    super(mensagem);
    this.status = status;
    this.detalhes = detalhes ?? null;
  }
}

async function chamar(metodo, caminho, corpo, { bruto = false, cabecalhos = {}, tipo } = {}) {
  const h = { ...cabecalhos };
  const s = sessao.get();
  if (s?.token) h.Authorization = `Bearer ${s.token}`;
  const p = perfil.get();
  if (p?.id) h['X-Perfil'] = String(p.id);
  if (p?.chave) h['X-Perfil-Chave'] = p.chave;
  let body;
  if (corpo instanceof Blob || corpo instanceof ArrayBuffer) {
    body = corpo;
    h['Content-Type'] = tipo ?? 'application/octet-stream';
  } else if (typeof corpo === 'string') {
    body = corpo;
    h['Content-Type'] = tipo ?? 'text/plain; charset=utf-8';
  } else if (corpo !== undefined) {
    body = JSON.stringify(corpo);
    h['Content-Type'] = 'application/json';
  }
  let resp;
  try {
    resp = await fetch(`${BASE}/api${caminho}`, { method: metodo, headers: h, body });
  } catch {
    throw new ErroApi('Sem conexão com o servidor. Verifique a internet.', 0);
  }
  if (resp.status === 401 && !caminho.startsWith('/auth/')) {
    sessao.limpar();
    window.dispatchEvent(new CustomEvent('tv:sair'));
  }
  if (!resp.ok) {
    let msg = `Erro ${resp.status}`;
    let detalhes = null;
    try {
      const j = await resp.json();
      msg = j.erro || msg;
      detalhes = j.detalhes ?? null;
    } catch { /* sem corpo */ }
    // 402: falta assinatura ativa. 423: o perfil pede PIN. As telas tratam estes dois.
    if (resp.status === 402) window.dispatchEvent(new CustomEvent('tv:assinatura', { detail: { mensagem: msg, detalhes } }));
    if (resp.status === 423) window.dispatchEvent(new CustomEvent('tv:pin', { detail: { mensagem: msg, detalhes } }));
    throw new ErroApi(msg, resp.status, detalhes);
  }
  if (bruto) return resp;
  if (resp.status === 204) return null;
  const ct = resp.headers.get('content-type') ?? '';
  return ct.includes('json') ? resp.json() : resp.text();
}

export const api = {
  get: (c, o) => chamar('GET', c, undefined, o),
  post: (c, b = {}, o) => chamar('POST', c, b, o),
  put: (c, b, o) => chamar('PUT', c, b, o),
  patch: (c, b, o) => chamar('PATCH', c, b, o),
  del: (c, o) => chamar('DELETE', c, undefined, o),
};

/** Endereço de uma arte (capa, banner, logo) pelo id do arquivo. */
export const arte = (id) => (id ? `${BASE}/api/arte/${id}` : null);
