const CHAVE = 'payax.sessao';

export const sessao = {
  get() {
    try { return JSON.parse(sessionStorage.getItem(CHAVE)) || null; } catch { return null; }
  },
  set(dados) {
    try { sessionStorage.setItem(CHAVE, JSON.stringify(dados)); } catch { /* armazenamento indisponível */ }
  },
  limpar() {
    try { sessionStorage.removeItem(CHAVE); } catch { /* ignora */ }
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
  const resp = await fetch(`/api${caminho}`, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  if (resp.status === 401 && !caminho.startsWith('/auth/login')) {
    sessao.limpar();
    window.dispatchEvent(new CustomEvent('payax:sair'));
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

const qs = (params = {}) => {
  const p = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return p.length ? `?${new URLSearchParams(p)}` : '';
};

export const api = {
  get: (c, params) => chamar('GET', c + qs(params)),
  post: (c, corpo = {}) => chamar('POST', c, corpo),
  put: (c, corpo = {}) => chamar('PUT', c, corpo),
  patch: (c, corpo = {}) => chamar('PATCH', c, corpo),
  del: (c) => chamar('DELETE', c),
  async baixar(c, params) {
    const resp = await chamar('GET', c + qs(params), undefined, { bruto: true });
    const nome = /filename="([^"]+)"/.exec(resp.headers.get('Content-Disposition') || '')?.[1] || 'relatorio.csv';
    const url = URL.createObjectURL(await resp.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: nome });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};
