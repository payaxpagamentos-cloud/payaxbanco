/** Endereço base do app (ex.: '/taxi'), deduzido de onde este arquivo foi carregado: funciona na raiz do domínio ou num caminho. */
export const BASE = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

/** Chamadas à API com a sessão de cada app (passageiro, motorista e central convivem no mesmo navegador). */
let CHAVE = 'taxi.sessao';
let memoria = null;
export const usarSessao = (nome) => { CHAVE = `taxi.sessao.${nome}`; };

export const sessao = {
  get() {
    try { return JSON.parse(localStorage.getItem(CHAVE)) || memoria; } catch { return memoria; }
  },
  set(dados) {
    memoria = dados;
    try { localStorage.setItem(CHAVE, JSON.stringify(dados)); } catch { /* armazenamento indisponível */ }
  },
  limpar() {
    memoria = null;
    try { localStorage.removeItem(CHAVE); } catch { /* ignora */ }
  },
};

export class ErroApi extends Error {
  constructor(mensagem, status) { super(mensagem); this.status = status; }
}

async function chamar(metodo, caminho, corpo, { bruto = false } = {}) {
  const headers = {};
  const s = sessao.get();
  if (s?.token) headers.Authorization = `Bearer ${s.token}`;
  if (corpo !== undefined) headers['Content-Type'] = 'application/json';
  let resp;
  try {
    resp = await fetch(`${BASE}/api${caminho}`, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  } catch {
    throw new ErroApi('Sem conexão com o servidor. Verifique a internet.', 0);
  }
  if (resp.status === 401 && !caminho.startsWith('/auth/')) {
    sessao.limpar();
    window.dispatchEvent(new CustomEvent('taxi:sair'));
  }
  if (!resp.ok) {
    let msg = `Erro ${resp.status}`;
    try { msg = (await resp.json()).erro || msg; } catch { /* sem corpo */ }
    throw new ErroApi(msg, resp.status);
  }
  if (bruto) return resp;
  if (resp.status === 204) return null;
  return resp.json();
}

export const api = {
  get: (c, o) => chamar('GET', c, undefined, o),
  post: (c, b = {}) => chamar('POST', c, b),
  patch: (c, b) => chamar('PATCH', c, b),
  put: (c, b) => chamar('PUT', c, b),
};
