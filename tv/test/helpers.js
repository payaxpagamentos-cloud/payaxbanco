'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.TV_SECRET = 'segredo-de-teste-com-mais-de-32-caracteres';
process.env.TV_LIMITE_LOGIN = '1000';
process.env.TV_PAGAMENTOS = 'simulado';
process.env.TV_RELAY = '1';
// Cada execução grava os arquivos numa pasta temporária própria.
process.env.TV_MIDIA = fs.mkdtempSync(path.join(os.tmpdir(), 'play-tech-vip-teste-'));

const { abrir } = require('../server/db');
const { criarApp } = require('../server/app');
const config = require('../server/config');

/** Vídeo MP4 mínimo (só o cabeçalho que o servidor reconhece) para os testes de envio. */
const videoFalso = (tamanho = 4096) => {
  const b = Buffer.alloc(tamanho, 7);
  Buffer.from('ftypisom').copy(b, 4);
  return b;
};

/** PNG de 1x1 válido. */
const imagemFalsa = () => Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64',
);

async function iniciar() {
  const db = abrir(':memory:');
  const servidor = criarApp(db).listen(0);
  await new Promise((r) => servidor.once('listening', r));
  const raiz = `http://127.0.0.1:${servidor.address().port}`;
  const base = `${raiz}${config.basePath}/api`;

  async function req(metodo, caminho, corpo, tk, extras = {}) {
    const cabecalhos = { ...(tk ? { Authorization: `Bearer ${tk}` } : {}), ...(extras.headers ?? {}) };
    let body;
    if (Buffer.isBuffer(corpo)) {
      body = corpo;
      cabecalhos['Content-Type'] = cabecalhos['Content-Type'] ?? 'application/octet-stream';
    } else if (typeof corpo === 'string') {
      body = corpo;
      cabecalhos['Content-Type'] = cabecalhos['Content-Type'] ?? 'text/plain';
    } else if (corpo !== undefined) {
      body = JSON.stringify(corpo);
      cabecalhos['Content-Type'] = 'application/json';
    }
    const resp = await fetch(base + caminho, { method: metodo, headers: cabecalhos, body });
    const texto = resp.headers.get('content-type')?.startsWith('video/') ? '' : await resp.text();
    let dados = texto;
    try { dados = JSON.parse(texto); } catch { /* csv, m3u8, svg ou vazio */ }
    return { status: resp.status, dados, headers: resp.headers };
  }

  const login = async (email, senha) => {
    const r = await req('POST', '/auth/login', { email, senha });
    if (r.status !== 200) throw new Error(`Login falhou para ${email}: ${JSON.stringify(r.dados)}`);
    return r.dados.token;
  };

  /** Cria um assinante e devolve o token, o perfil e a função de assinar um plano. */
  async function assinante(email = 'cliente@exemplo.com.br', { plano = null, pagar = true } = {}) {
    const r = await req('POST', '/auth/cadastro', { nome: 'Cliente de Teste', email, telefone: '11999990000', senha: 'senha12345' });
    if (r.status !== 201) throw new Error(`Cadastro falhou: ${JSON.stringify(r.dados)}`);
    const tk = r.dados.token;
    const perfilId = r.dados.perfis[0].id;
    if (plano) {
      const a = await req('POST', '/conta/assinar', { plano_id: plano }, tk);
      if (a.status !== 201) throw new Error(`Assinatura falhou: ${JSON.stringify(a.dados)}`);
      if (pagar) {
        const p = await req('POST', `/conta/faturas/${a.dados.fatura.id}/pagar`, {}, tk);
        if (p.status !== 200) throw new Error(`Pagamento falhou: ${JSON.stringify(p.dados)}`);
      }
    }
    return { token: tk, perfilId, usuario: r.dados.usuario, comPerfil: { headers: { 'X-Perfil': String(perfilId) } } };
  }

  /** Envia um vídeo pelo painel (abrir, mandar os pedaços, concluir) e devolve o id da mídia. */
  async function enviarVideo(tkAdmin, { tamanho = 4096, duracao = 120, altura = 1080 } = {}) {
    const conteudo = videoFalso(tamanho);
    const abertura = await req('POST', '/admin/midias/video', { nome: 'filme.mp4', tamanho: conteudo.length, duracao_s: duracao, largura: 1920, altura }, tkAdmin);
    if (abertura.status !== 201) throw new Error(`Abrir envio falhou: ${JSON.stringify(abertura.dados)}`);
    const id = abertura.dados.midia.id;
    const pedaco = 1024;
    for (let off = 0; off < conteudo.length; off += pedaco) {
      const parte = conteudo.subarray(off, Math.min(off + pedaco, conteudo.length));
      const p = await req('PUT', `/admin/midias/${id}/parte?offset=${off}`, parte, tkAdmin);
      if (p.status !== 200) throw new Error(`Parte falhou: ${JSON.stringify(p.dados)}`);
    }
    const fim = await req('POST', `/admin/midias/${id}/concluir`, { duracao_s: duracao }, tkAdmin);
    if (fim.status !== 200) throw new Error(`Concluir falhou: ${JSON.stringify(fim.dados)}`);
    return id;
  }

  async function enviarImagem(tkAdmin) {
    const r = await req('POST', '/admin/midias/imagem?nome=capa.png', imagemFalsa(), tkAdmin, { headers: { 'Content-Type': 'image/png' } });
    if (r.status !== 201) throw new Error(`Imagem falhou: ${JSON.stringify(r.dados)}`);
    return r.dados.midia.id;
  }

  return {
    db,
    raiz,
    base,
    req,
    login,
    assinante,
    enviarVideo,
    enviarImagem,
    videoFalso,
    imagemFalsa,
    adminLogin: () => login(config.admin.email, config.admin.senha),
    get: (c, tk, e) => req('GET', c, undefined, tk, e),
    post: (c, b, tk, e) => req('POST', c, b ?? {}, tk, e),
    put: (c, b, tk, e) => req('PUT', c, b, tk, e),
    patch: (c, b, tk, e) => req('PATCH', c, b, tk, e),
    del: (c, tk, e) => req('DELETE', c, undefined, tk, e),
    fechar: () => new Promise((r) => servidor.close(r)),
  };
}

module.exports = { iniciar, videoFalso, imagemFalsa };
