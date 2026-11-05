'use strict';

/*
 * Downdetector (contexto externo). Não há credenciais nem a lista de recursos do contrato do usuário, e os endpoints
 * não são presumidos: o endereço, o caminho da consulta, o cabeçalho de autenticação e onde ler o volume de relatos e a
 * referência (baseline) são configurados a partir da documentação do acesso autorizado (https://downdetectorapi.com/v2/docs/).
 * Sem configuração, a integração fica "não configurada" e a tela oferece só o link para o site oficial. Sem scraping, sem iframe.
 */

const { agora, transacao } = require('../db');
const base = require('./base');

const TIPO = 'downdetector';
const INTERVALO_PADRAO_S = 300;
const intervalo = (cfg) => Math.max(120, Number(cfg.intervalo_s) || INTERVALO_PADRAO_S);

/** Lê um campo por caminho com pontos e índices (ex.: "data.0.reports"). */
function campo(obj, caminho) {
  if (!caminho) return undefined;
  return String(caminho).split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[/^\d+$/.test(k) ? Number(k) : k]), obj);
}

/** Classificação honesta do sinal externo: sem dados não é "normal"; pico é indício, não causa confirmada. */
function classificar(relatos, baseline, fator) {
  if (relatos === null || relatos === undefined || !Number.isFinite(relatos)) return 'sem_dados';
  if (relatos === 0) return 'sem_relatos_relevantes';
  if (baseline === null || baseline === undefined || !Number.isFinite(baseline)) return 'sem_dados';
  return relatos >= Math.max(1, baseline) * fator ? 'indicio_externo' : 'sem_relatos_relevantes';
}

function urlConsulta(cfg, servico) {
  v(cfg.url_base, 'o endereço base da API');
  v(cfg.caminho, 'o caminho da consulta (com {servico})');
  return `${String(cfg.url_base).replace(/\/+$/, '')}/${String(cfg.caminho).replace(/^\/+/, '')}`
    .replaceAll('{servico}', encodeURIComponent(servico.referencia)).replaceAll('{regiao}', encodeURIComponent(servico.regiao ?? ''));
}
function v(x, nome) { if (!x) throw new base.ErroConector(`Informe ${nome}.`, 'nao_configurada', { permanente: true }); }

async function coletar(db, org) {
  const x = base.ler(db, org, TIPO);
  const inicio = Date.now();
  try {
    if (!x) throw new base.ErroConector('Integração não configurada.', 'nao_configurada', { permanente: true });
    const token = base.segredoDe(x);
    if (!token) throw new base.ErroConector('Informe a credencial do acesso autorizado.', 'nao_configurada', { permanente: true });
    const servicos = db.prepare('SELECT * FROM servicos_externos WHERE organizacao_id = ? AND ativo = 1').all(org);
    if (!servicos.length) throw new base.ErroConector('Cadastre ao menos um serviço acompanhado.', 'nao_configurada', { permanente: true });
    const cab = { [x.config.cabecalho_auth || 'Authorization']: `${x.config.prefixo_auth === undefined ? 'Bearer ' : x.config.prefixo_auth ? `${x.config.prefixo_auth} ` : ''}${token}` };
    const fator = Number(x.config.fator_indicio) > 1 ? Number(x.config.fator_indicio) : 2;
    let ok = 0;
    const falhas = [];
    for (const s of servicos) {
      try {
        const dados = await base.buscarJson(urlConsulta(x.config, s), cab);
        const relatos = Number(campo(dados, x.config.campo_relatos));
        const bl = Number(campo(dados, x.config.campo_baseline));
        const r = { relatos: Number.isFinite(relatos) ? Math.round(relatos) : null, baseline: Number.isFinite(bl) ? bl : null,
          inicio: campo(dados, x.config.campo_periodo_inicio) ?? null, fim: campo(dados, x.config.campo_periodo_fim) ?? null };
        transacao(db, () => db.prepare(`INSERT INTO amostras_servico_externo (organizacao_id, servico_id, regiao, periodo_inicio, periodo_fim, relatos, baseline, sinal, coletado_em)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(org, s.id, s.regiao, r.inicio ? String(r.inicio) : null, r.fim ? String(r.fim) : null, r.relatos, r.baseline,
          classificar(r.relatos, r.baseline, fator), agora()));
        ok++;
      } catch (err) {
        if (err.estado === 'sem_permissao' || err.estado === 'limite_atingido') throw err;
        falhas.push(`${s.nome}: ${err.message}`);
      }
    }
    if (!ok) throw new base.ErroConector(`Nenhum serviço respondeu. ${falhas.join(' | ')}`.slice(0, 300));
    base.registrarResultado(db, org, TIPO, { inicio, itens: ok, parcial: falhas.length ? falhas.join(' | ').slice(0, 300) : false, intervaloS: intervalo(x.config) });
    return { servicos: servicos.length, coletados: ok, falhas };
  } catch (err) {
    base.registrarResultado(db, org, TIPO, { inicio, erro: err, intervaloS: intervalo(x?.config ?? {}) });
    throw err;
  }
}

module.exports = { TIPO, coletar, classificar, campo, intervalo, INTERVALO_PADRAO_S, SITE_OFICIAL: 'https://downdetector.com.br/' };
