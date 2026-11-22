/** Endereço base do painel (ex.: '/pabx'), deduzido de onde este arquivo foi carregado: funciona na raiz do domínio ou num caminho. */
export const BASE = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

const CHAVE = 'midia.sessao';
const CHAVE_EMAIL = 'midia.ultimo-email';
let memoria = null;

/**
 * A sessão de quem entrou.
 *
 * Com "lembrar de mim" marcado, ela fica guardada no navegador e continua valendo depois de fechar a
 * janela; sem marcar, vive só enquanto a aba estiver aberta — é o certo para computador de recepção,
 * de portaria ou emprestado, onde a próxima pessoa não pode cair dentro do painel de quem usou antes.
 */
export const sessao = {
  get() {
    for (const guarda of [localStorage, sessionStorage]) {
      try {
        const bruto = guarda.getItem(CHAVE);
        if (bruto) return JSON.parse(bruto);
      } catch { /* armazenamento indisponível */ }
    }
    return memoria;
  },
  set(dados, { lembrar = true } = {}) {
    memoria = dados;
    const guarda = lembrar ? localStorage : sessionStorage;
    const outro = lembrar ? sessionStorage : localStorage;
    try { guarda.setItem(CHAVE, JSON.stringify(dados)); } catch { /* armazenamento indisponível */ }
    try { outro.removeItem(CHAVE); } catch { /* ignora */ }
  },
  /** Troca só o acesso (depois de mudar a senha), sem mexer em onde ele está guardado. */
  trocarToken(token) {
    let lembrar = false;
    try { lembrar = Boolean(localStorage.getItem(CHAVE)); } catch { /* ignora */ }
    this.set({ ...this.get(), token }, { lembrar });
  },
  limpar() {
    memoria = null;
    for (const guarda of [localStorage, sessionStorage]) {
      try { guarda.removeItem(CHAVE); } catch { /* ignora */ }
    }
  },
  /** O e-mail de quem entrou por último, só para não digitar de novo. Senha nunca é guardada. */
  lembrarEmail(email) {
    try {
      if (email) localStorage.setItem(CHAVE_EMAIL, email);
      else localStorage.removeItem(CHAVE_EMAIL);
    } catch { /* ignora */ }
  },
  emailLembrado() {
    try { return localStorage.getItem(CHAVE_EMAIL) ?? ''; } catch { return ''; }
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
  // Internet que trava sem cair deixava o botão girando para sempre. Com limite, a tela avisa e dá para tentar de novo.
  // (Baixar arquivo fica sem limite: backup e vídeo podem demorar de verdade.)
  const corte = !bruto && typeof AbortController === 'function' ? new AbortController() : null;
  const relogio = corte ? setTimeout(() => corte.abort(), 90_000) : null;
  try {
    resp = await fetch(`${BASE}/api${caminho}`, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo), signal: corte?.signal });
  } catch (err) {
    throw new ErroApi(err?.name === 'AbortError'
      ? 'O servidor demorou demais para responder. Confira a internet e tente de novo.'
      : 'Sem conexão com o servidor. Verifique a internet.', 0);
  } finally {
    clearTimeout(relogio);
  }
  if (resp.status === 401 && !caminho.startsWith('/auth/')) {
    sessao.limpar();
    window.dispatchEvent(new CustomEvent('midia:sair'));
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
  del: (c, b) => chamar('DELETE', c, b),
};

/** Baixa um arquivo da API (com a sessão) e entrega ao navegador. */
export async function baixar(caminho, nome) {
  const resp = await chamar('GET', caminho, undefined, { bruto: true });
  const url = URL.createObjectURL(await resp.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: nome });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Query string sem os campos vazios. */
export const qs = (o) => {
  const p = new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v !== null && v !== undefined));
  return p.toString() ? `?${p}` : '';
};
