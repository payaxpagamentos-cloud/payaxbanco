import { RAIZ } from './raiz.js';

const CHAVE = 'payax.ib.sessao';
let memoria = null;

export const sessao = {
  get() { try { return JSON.parse(sessionStorage.getItem(CHAVE)) || memoria; } catch { return memoria; } },
  set(d) { memoria = d; try { sessionStorage.setItem(CHAVE, JSON.stringify(d)); } catch { /* indisponível */ } },
  limpar() { memoria = null; try { sessionStorage.removeItem(CHAVE); } catch { /* ignora */ } },
};

export class ErroApi extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

async function chamar(metodo, caminho, corpo) {
  const headers = {};
  const s = sessao.get();
  if (s?.token) headers.Authorization = `Bearer ${s.token}`;
  if (corpo !== undefined) headers['Content-Type'] = 'application/json';
  const resp = await fetch(`${RAIZ}api/ib${caminho}`, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  if (resp.status === 401 && caminho !== '/auth/login') {
    sessao.limpar();
    window.dispatchEvent(new CustomEvent('payax-ib:sair', { detail: 'Sua sessão expirou. Entre novamente.' }));
  }
  if (!resp.ok) {
    let msg = `Erro ${resp.status}`;
    try { msg = (await resp.json()).erro || msg; } catch { /* sem corpo */ }
    throw new ErroApi(msg, resp.status);
  }
  return resp.status === 204 ? null : resp.json();
}

const qs = (p = {}) => {
  const e = Object.entries(p).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return e.length ? `?${new URLSearchParams(e)}` : '';
};

export const api = {
  get: (c, p) => chamar('GET', c + qs(p)),
  post: (c, b = {}) => chamar('POST', c, b),
  del: (c) => chamar('DELETE', c),
};
