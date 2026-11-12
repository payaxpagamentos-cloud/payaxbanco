/** Endereço base do sistema (ex.: '/mercadinho'), deduzido de onde este arquivo foi carregado. */
export const BASE = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

const CHAVE = 'mercadinho.sessao';
let memoria = null;

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

async function chamar(metodo, caminho, corpo) {
  const headers = {};
  const s = sessao.get();
  if (s?.token) headers.Authorization = `Bearer ${s.token}`;
  if (corpo !== undefined) headers['Content-Type'] = 'application/json';
  let resp;
  try {
    resp = await fetch(`${BASE}/api${caminho}`, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  } catch {
    throw new ErroApi('Sem conexão com o servidor. Verifique a rede.', 0);
  }
  if (resp.status === 401 && !caminho.startsWith('/auth/login')) {
    sessao.limpar();
    window.dispatchEvent(new CustomEvent('mercadinho:sair'));
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
  /** Endereço absoluto de um arquivo da API (usado nos downloads de CSV). */
  url: (c) => `${BASE}/api${c}`,
};

/** Baixa um CSV da API levando o token da sessão. */
export async function baixar(caminho, nome) {
  const s = sessao.get();
  const resp = await fetch(api.url(caminho), { headers: s?.token ? { Authorization: `Bearer ${s.token}` } : {} });
  if (!resp.ok) throw new ErroApi('Não foi possível gerar o arquivo.', resp.status);
  const blob = await resp.blob();
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = nome;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 5000);
}
