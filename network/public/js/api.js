/** Comunicação com o servidor. A sessão (token) fica no navegador; todos os dados ficam no servidor. */
export const BASE = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

const CHAVE = 'network.sessao';
let memoria = null;
export const sessao = {
  get() { try { return JSON.parse(localStorage.getItem(CHAVE)) || memoria; } catch { return memoria; } },
  set(d) { memoria = d; try { localStorage.setItem(CHAVE, JSON.stringify(d)); } catch { /* sem armazenamento: vale só nesta aba */ } },
  limpar() { memoria = null; try { localStorage.removeItem(CHAVE); } catch { /* ignora */ } },
};

export class ErroApi extends Error {
  constructor(msg, status, dados) { super(msg); this.status = status; this.dados = dados; }
}

const novaChave = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

async function chamar(metodo, caminho, corpo, { bruto = false, arquivo = null, idempotente = metodo === 'POST' } = {}) {
  const headers = {};
  const s = sessao.get();
  if (s?.token) headers.Authorization = `Bearer ${s.token}`;
  // Cada comando POST leva uma chave de idempotência: um duplo envio (clique repetido, reenvio da rede) não duplica.
  if (idempotente) headers['Idempotency-Key'] = novaChave();
  let body;
  if (arquivo) {
    body = arquivo;
    headers['X-Nome-Arquivo'] = encodeURIComponent(arquivo.name || 'arquivo');
    headers['Content-Type'] = arquivo.type || 'application/octet-stream';
  } else if (corpo !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(corpo);
  }
  let resp;
  try {
    resp = await fetch(`${BASE}/api${caminho}`, { method: metodo, headers, body, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new ErroApi(err.name === 'TimeoutError' ? 'O servidor demorou para responder. Tente de novo.' : 'Sem conexão com o servidor. Verifique a internet.', 0);
  }
  if (resp.status === 401 && !caminho.startsWith('/auth/login')) {
    sessao.limpar();
    window.dispatchEvent(new CustomEvent('network:sair'));
  }
  if (!resp.ok) {
    let dados = null;
    try { dados = await resp.json(); } catch { /* sem corpo */ }
    throw new ErroApi(dados?.erro || `Erro ${resp.status}`, resp.status, dados);
  }
  if (bruto) return resp;
  if (resp.status === 204) return null;
  return resp.json();
}

export const api = {
  get: (c, o) => chamar('GET', c, undefined, { ...o, idempotente: false }),
  post: (c, b = {}) => chamar('POST', c, b),
  patch: (c, b) => chamar('PATCH', c, b),
  put: (c, b) => chamar('PUT', c, b),
  enviarArquivo: (recurso, recursoId, arquivo) => chamar('POST', `/anexos?recurso=${recurso}${recursoId ? `&recurso_id=${recursoId}` : ''}`, undefined, { arquivo }),
};

/** Abre um anexo por link temporário (a permissão é conferida no servidor). */
export async function abrirAnexo(id) {
  const l = await api.get(`/anexos/${id}/link`);
  window.open(`${BASE}${l.url}`, '_blank', 'noopener');
}

export async function baixar(caminho, nome) {
  const resp = await chamar('GET', caminho, undefined, { bruto: true, idempotente: false });
  const url = URL.createObjectURL(await resp.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: nome });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const qs = (o) => {
  const p = new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v !== null && v !== undefined));
  return p.toString() ? `?${p}` : '';
};
