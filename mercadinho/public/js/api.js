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

/** Envia um arquivo (a foto do produto vai como imagem mesmo, sem base64 no meio). */
async function enviarArquivo(caminho, blob) {
  const s = sessao.get();
  const resp = await fetch(`${BASE}/api${caminho}`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream', ...(s?.token ? { Authorization: `Bearer ${s.token}` } : {}) },
    body: blob,
  });
  if (!resp.ok) {
    let msg = `Erro ${resp.status}`;
    try { msg = (await resp.json()).erro || msg; } catch { /* sem corpo */ }
    throw new ErroApi(msg, resp.status);
  }
  return resp.json();
}

/**
 * Envia um arquivo grande (vídeo da vitrine) avisando o andamento — fetch não informa o progresso do envio.
 * aoProgredir recebe de 0 a 1.
 */
function enviarComProgresso(caminho, arquivo, aoProgredir) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE}/api${caminho}`);
    const s = sessao.get();
    if (s?.token) xhr.setRequestHeader('Authorization', `Bearer ${s.token}`);
    xhr.setRequestHeader('Content-Type', arquivo.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) aoProgredir?.(e.loaded / e.total); };
    xhr.onerror = () => reject(new ErroApi('Sem conexão com o servidor. Verifique a rede.', 0));
    xhr.onload = () => {
      let corpo = null;
      try { corpo = JSON.parse(xhr.responseText); } catch { /* sem corpo */ }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(corpo);
      // 413 sem JSON vem do nginx, antes de chegar ao sistema: o limite de envio dele está baixo.
      const msg = corpo?.erro || (xhr.status === 413 ? 'Arquivo grande demais para o servidor (limite de envio do nginx).' : `Erro ${xhr.status}`);
      return reject(new ErroApi(msg, xhr.status));
    };
    xhr.send(arquivo);
  });
}

export const api = {
  get: (c) => chamar('GET', c),
  enviarArquivo,
  enviarComProgresso,
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
