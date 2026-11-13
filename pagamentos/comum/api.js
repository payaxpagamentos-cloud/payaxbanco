/** Comunicação com o servidor, compartilhada pelo Backoffice e pelo Internet Bank. */

export class ErroApi extends Error {
  constructor(msg, status, dados) { super(msg); this.status = status; this.dados = dados; }
}

const novaChave = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/**
 * @param {{ base: string, chave: string, evento: string }} opcoes
 *  base   — prefixo das rotas (ex.: '/pagamentos' ou '/pagamentos/cliente');
 *  chave  — nome da sessão no navegador;
 *  evento — evento disparado quando a sessão cai.
 */
export function criarApi({ base, chave, evento }) {
  let memoria = null;
  const sessao = {
    get() { try { return JSON.parse(localStorage.getItem(chave)) || memoria; } catch { return memoria; } },
    set(d) { memoria = d; try { localStorage.setItem(chave, JSON.stringify(d)); } catch { /* sem armazenamento: vale só nesta aba */ } },
    limpar() { memoria = null; try { localStorage.removeItem(chave); } catch { /* ignora */ } },
  };

  async function chamar(metodo, caminho, corpo, { bruto = false, arquivo = null, idempotente = metodo === 'POST' } = {}) {
    const headers = {};
    const s = sessao.get();
    if (s?.token) headers.Authorization = `Bearer ${s.token}`;
    // Cada comando POST leva uma chave de idempotência: clique duplo não emite dois boletos.
    if (idempotente) headers['Idempotency-Key'] = novaChave();
    let body;
    if (arquivo) {
      body = arquivo;
      headers['X-Nome-Arquivo'] = encodeURIComponent(arquivo.name || 'arquivo');
      headers['Content-Type'] = 'application/octet-stream';
    } else if (corpo !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(corpo);
    }
    let resp;
    try {
      resp = await fetch(`${base}/api${caminho}`, { method: metodo, headers, body, signal: AbortSignal.timeout(45_000) });
    } catch (err) {
      throw new ErroApi(err.name === 'TimeoutError' ? 'O servidor demorou para responder. Tente de novo.' : 'Sem conexão com o servidor.', 0);
    }
    if (resp.status === 401 && !caminho.startsWith('/auth/login')) {
      sessao.limpar();
      window.dispatchEvent(new CustomEvent(evento));
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

  const api = {
    base,
    sessao,
    get: (c) => chamar('GET', c, undefined, { idempotente: false }),
    post: (c, b = {}) => chamar('POST', c, b),
    patch: (c, b) => chamar('PATCH', c, b),
    put: (c, b) => chamar('PUT', c, b),
    /** Envia um arquivo como corpo bruto (retorno do banco). */
    enviarArquivo: (caminho, arquivo) => chamar('POST', caminho, undefined, { arquivo }),
    /** Abre uma página do servidor (ficha de compensação) numa aba nova, levando a sessão. */
    async abrirPagina(caminho) {
      const resp = await chamar('GET', caminho, undefined, { bruto: true, idempotente: false });
      const url = URL.createObjectURL(new Blob([await resp.text()], { type: 'text/html' }));
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    async baixar(caminho, nome) {
      const resp = await chamar('GET', caminho, undefined, { bruto: true, idempotente: false });
      const url = URL.createObjectURL(await resp.blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: nome });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  };
  return api;
}

export const qs = (o) => {
  const p = new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v !== null && v !== undefined));
  return p.toString() ? `?${p}` : '';
};
