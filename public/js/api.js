/** Endereço base do sistema (ex.: '/bpo'), deduzido de onde este arquivo foi carregado: funciona na raiz ou num caminho. */
export const BASE = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

let enderecosCache = null;
/** Endereços do sistema da equipe e do Portal ({ equipe, portal }), configurados no servidor. */
export const enderecos = () => (enderecosCache ??= fetch(`${BASE}/api/enderecos`).then((r) => r.json()).catch(() => ({ equipe: '/', portal: '/portal/' })));

let CHAVE = 'bpo.sessao';
/** O Portal do Cliente usa outra chave: as duas sessões convivem no mesmo navegador. */
export const usarChaveSessao = (chave) => { CHAVE = chave; };

// Cópia em memória garante a sessão mesmo quando o sessionStorage está bloqueado.
let memoria = null;
export const sessao = {
  get() {
    try { return JSON.parse(sessionStorage.getItem(CHAVE)) || memoria; } catch { return memoria; }
  },
  set(dados) {
    memoria = dados;
    try { sessionStorage.setItem(CHAVE, JSON.stringify(dados)); } catch { /* armazenamento indisponível */ }
  },
  limpar() {
    memoria = null;
    try { sessionStorage.removeItem(CHAVE); } catch { /* ignora */ }
  },
};

export class ErroApi extends Error {
  constructor(mensagem, status) { super(mensagem); this.status = status; }
}

async function chamar(metodo, caminho, corpo, { bruto = false, binario = false } = {}) {
  const headers = {};
  const s = sessao.get();
  if (s?.token) headers.Authorization = `Bearer ${s.token}`;
  if (corpo !== undefined) headers['Content-Type'] = binario ? 'application/octet-stream' : 'application/json';
  const body = corpo === undefined ? undefined : binario ? corpo : JSON.stringify(corpo);
  const resp = await fetch(`${BASE}/api${caminho}`, { method: metodo, headers, body });
  if (resp.status === 401 && !caminho.startsWith('/auth/login')) {
    sessao.limpar();
    window.dispatchEvent(new CustomEvent('bpo:sair'));
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
  /** Envia um arquivo (corpo binário); metadados vão na query string. */
  enviarArquivo: (c, params, arquivo) => chamar('POST', c + qs(params), arquivo, { binario: true }),
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
