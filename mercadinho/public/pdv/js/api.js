/** Endereço base do sistema, deduzido de onde este arquivo foi carregado (.../pdv/js/api.js). */
export const BASE = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');

// O token do terminal fica neste aparelho. Não é de ninguém: a administração pode desativá-lo quando quiser.
const CHAVE = 'mercadinho.terminal';
let memoria = null;

export const pareamento = {
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

async function chamar(metodo, caminho, corpo) {
  const headers = {};
  const p = pareamento.get();
  if (p?.token) headers.Authorization = `Bearer ${p.token}`;
  if (corpo !== undefined) headers['Content-Type'] = 'application/json';
  let resp;
  try {
    resp = await fetch(`${BASE}/api/terminal${caminho}`, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  } catch {
    throw new ErroApi('Sem conexão com o servidor. Chame a administração.', 0);
  }
  // Token recusado (terminal desativado ou expirado): volta para a tela de pareamento.
  if ((resp.status === 401 || resp.status === 403) && !caminho.startsWith('/parear')) {
    pareamento.limpar();
    window.dispatchEvent(new CustomEvent('terminal:despareado'));
  }
  if (!resp.ok) {
    let msg = `Erro ${resp.status}`;
    try { msg = (await resp.json()).erro || msg; } catch { /* sem corpo */ }
    throw new ErroApi(msg, resp.status);
  }
  if (resp.status === 204) return null;
  return resp.json();
}

export const api = {
  get: (c) => chamar('GET', c),
  post: (c, b = {}) => chamar('POST', c, b),
  patch: (c, b = {}) => chamar('PATCH', c, b),
  delete: (c) => chamar('DELETE', c),
};
