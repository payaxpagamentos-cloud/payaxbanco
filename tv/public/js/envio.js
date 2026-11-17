import { api, BASE, sessao } from './api.js';

/**
 * Envio de arquivos pelo painel. O vídeo vai em pedaços (o servidor aceita retomar
 * do ponto que recebeu), a arte e a legenda vão inteiras.
 */

/** Lê duração e tamanho da imagem do vídeo no próprio navegador (não precisa de ffmpeg no servidor). */
export function lerDadosDoVideo(arquivo) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(arquivo);
    const v = document.createElement('video');
    v.preload = 'metadata';
    const fim = (dados) => { URL.revokeObjectURL(url); resolve(dados); };
    v.addEventListener('loadedmetadata', () => fim({
      duracao_s: Number.isFinite(v.duration) ? Math.round(v.duration) : null,
      largura: v.videoWidth || null,
      altura: v.videoHeight || null,
    }));
    v.addEventListener('error', () => fim({ duracao_s: null, largura: null, altura: null }));
    v.src = url;
  });
}

/**
 * Envia o vídeo em pedaços. `aoProgresso(percentual, enviados, total)` é chamado a cada parte.
 * Devolve o id do arquivo no acervo.
 */
export async function enviarVideo(arquivo, { aoProgresso } = {}) {
  const dados = await lerDadosDoVideo(arquivo);
  const abertura = await api.post('/admin/midias/video', { nome: arquivo.name, tamanho: arquivo.size, ...dados });
  const id = abertura.midia.id;
  const tamanhoParte = abertura.parte_max_bytes ?? 8 * 1024 * 1024;
  const s = sessao.get();

  let enviados = 0;
  while (enviados < arquivo.size) {
    const parte = arquivo.slice(enviados, Math.min(enviados + tamanhoParte, arquivo.size));
    // fetch direto (sem o auxiliar) para mandar o pedaço como corpo binário puro.
    const resp = await fetch(`${BASE}/api/admin/midias/${id}/parte?offset=${enviados}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/octet-stream' },
      body: parte,
    });
    if (!resp.ok) {
      let msg = `Falha ao enviar (erro ${resp.status})`;
      try { msg = (await resp.json()).erro ?? msg; } catch { /* sem corpo */ }
      throw new Error(msg);
    }
    const r = await resp.json();
    enviados = r.recebido;
    aoProgresso?.(Math.round((enviados / arquivo.size) * 100), enviados, arquivo.size);
  }
  const fim = await api.post(`/admin/midias/${id}/concluir`, dados);
  return fim.midia;
}

export async function enviarImagem(arquivo) {
  const r = await api.post(`/admin/midias/imagem?nome=${encodeURIComponent(arquivo.name)}`, arquivo, { tipo: arquivo.type || 'application/octet-stream' });
  return r.midia;
}

export async function enviarLegenda(arquivo, { idioma = 'pt-BR', rotulo = 'Português' } = {}) {
  const r = await api.post(`/admin/midias/legenda?nome=${encodeURIComponent(arquivo.name)}&idioma=${encodeURIComponent(idioma)}&rotulo=${encodeURIComponent(rotulo)}`,
    arquivo, { tipo: 'text/vtt' });
  return r.midia;
}

/** Lê um arquivo de texto (XMLTV) para enviar à importação da grade. */
export const lerTexto = (arquivo) => arquivo.text();
