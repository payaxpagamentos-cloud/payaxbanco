'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

/**
 * Guarda da atualização: se a versão recém-instalada não ficar de pé, o sistema volta sozinho para a anterior.
 *
 * Como funciona: ao aplicar um pacote, o atualizador deixa uma marca ("pendente") com o backup da versão anterior. A cada
 * partida, antes de carregar qualquer outra coisa, esta guarda conta a tentativa. Se o painel ficar no ar por alguns segundos,
 * a marca some (deu certo). Se cair antes disso por duas partidas seguidas, a terceira restaura o backup e sai: o PM2/Docker
 * sobe de novo já na versão anterior, e o menu Sistema mostra o que aconteceu. Ninguém precisa entrar no servidor.
 *
 * Só usa módulos do próprio Node e não lê a configuração: tem de funcionar mesmo quando o resto da versão nova não carrega.
 */
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..', '..');
const DIR = path.join(RAIZ, 'data', 'atualizacoes');
const PENDENTE = path.join(DIR, 'pendente.json');
const FALHA = path.join(DIR, 'ultima-falha.json');
const TENTATIVAS = 2;        // partidas que podem falhar antes de voltar a versão
const DE_PE_MS = 15_000;     // no ar por este tempo = atualização confirmada

const ler = (arq) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return null; } };
const gravar = (arq, dados) => { try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(arq, JSON.stringify(dados)); } catch { /* disco sem espaço: segue */ } };
const apagar = (arq) => { try { fs.rmSync(arq, { force: true }); } catch { /* ignora */ } };

/** Chamado pelo atualizador logo depois de copiar a versão nova. */
function marcar({ backup, de, para }) {
  apagar(FALHA);
  gravar(PENDENTE, { backup, de, para, tentativas: 0, em: new Date().toISOString() });
}

/** Volta os arquivos do backup e registra a falha. Devolve true se restaurou. */
function restaurar(p) {
  const pasta = path.join(DIR, path.basename(String(p.backup ?? '')));
  if (!p.backup || !fs.existsSync(path.join(pasta, 'server', 'index.js'))) return false;
  fs.cpSync(path.join(pasta, 'server'), path.join(RAIZ, 'server'), { recursive: true });
  fs.cpSync(path.join(pasta, 'public'), path.join(RAIZ, 'public'), { recursive: true });
  gravar(FALHA, { versao: p.para ?? null, voltou_para: p.de ?? null, erro: String(p.erro ?? '').slice(0, 600) || null, em: new Date().toISOString() });
  // O serviço dos rastreadores (processo separado) reinicia para também voltar ao código anterior.
  try {
    const dados = process.env.RASTREADOR_DB ? path.dirname(process.env.RASTREADOR_DB) : path.join(RAIZ, 'data');
    fs.writeFileSync(path.join(dados, 'gt06-reiniciar'), new Date().toISOString());
  } catch { /* sem o serviço separado, nada a avisar */ }
  return true;
}

/** Primeira coisa na partida do painel. */
function aoIniciar() {
  const p = ler(PENDENTE);
  if (!p) return;
  if ((p.tentativas ?? 0) >= TENTATIVAS) {
    apagar(PENDENTE);
    let ok = false;
    try { ok = restaurar(p); } catch (err) { console.error('[Rastreador] Não consegui restaurar a versão anterior:', err.message); }
    if (ok) {
      console.error(`[Rastreador] A versão ${p.para} não iniciou. Versão anterior (${p.de}) restaurada; reiniciando.`);
      process.exit(1);
    }
    return;
  }
  gravar(PENDENTE, { ...p, tentativas: (p.tentativas ?? 0) + 1 });
  // O motivo da queda fica guardado para aparecer no menu Sistema.
  const anotar = (err) => {
    const atual = ler(PENDENTE);
    if (atual) gravar(PENDENTE, { ...atual, erro: String(err?.message ?? err).slice(0, 600) });
  };
  process.on('uncaughtException', (err) => { anotar(err); console.error(err); process.exit(1); });
  process.on('unhandledRejection', (err) => { anotar(err); console.error(err); process.exit(1); });
}

/** Chamado quando o painel já está atendendo: depois de alguns segundos de pé, a atualização está confirmada. */
function aoAtender() {
  if (!fs.existsSync(PENDENTE)) return;
  setTimeout(() => apagar(PENDENTE), DE_PE_MS).unref();
}

const ultimaFalha = () => ler(FALHA);
const pendente = () => ler(PENDENTE);

module.exports = { marcar, aoIniciar, aoAtender, ultimaFalha, pendente, restaurar, PENDENTE, FALHA };
