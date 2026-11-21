'use strict';

const { Router } = require('express');
const { agora, transacao } = require('../db');
const { exigir } = require('../auth');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { dataLocal, somarDias } = require('../lib/datas');
const { csv } = require('../lib/http');
const pano = require('../lib/panorama');
const conexao = require('../lib/conexao');
const prov = require('../lib/provisionamento');
const noc = require('../lib/noc');
const v = require('../lib/validacao');

/*
 * Panorama: a operação num mapa só.
 *
 * Toda rota daqui devolve, junto com os dados, DE ONDE eles vieram e QUANDO. Um mapa é uma afirmação muito
 * forte — "este cliente está no ar" — e sem a procedência vira adivinhação com cara de certeza.
 */
module.exports = (db) => {
  const r = Router();
  const org = (req) => db.prepare('SELECT fuso, sessoes_minutos, reconciliacao_horas FROM organizacoes WHERE id = ?').get(req.org);
  /** Uma leitura vale como "agora" por três ciclos de varredura: dá folga para um ciclo perdido sem mentir. */
  const opcoes = (req) => {
    const o = org(req);
    const minutos = o.sessoes_minutos ? o.sessoes_minutos * 3 : (o.reconciliacao_horas || 12) * 60;
    return { fuso: o.fuso, validadeMin: Math.max(minutos, 3), agora: new Date() };
  };
  const filtrosDe = (q) => ({
    estado: q.estado ? String(q.estado).split(',').filter(Boolean) : null,
    contrato_situacao: q.contrato_situacao || null,
    plano_id: q.plano_id, cto_id: q.cto_id, concentrador_id: q.concentrador_id, olt_id: q.olt_id,
    tecnologia: q.tecnologia || null, tipo_acesso: q.tipo_acesso || null, bairro: q.bairro || null,
    busca: q.busca || null, quedas_min: q.quedas_min,
    incluir_cancelados: q.incluir_cancelados === '1',
  });

  // ---------------- Mapa ----------------
  r.get('/pontos', exigir('panorama.ver'), (req, res) => {
    const op = opcoes(req);
    const d = pano.pontos(db, req.org, filtrosDe(req.query), op);
    res.json({
      ...d,
      fonte: {
        validade_min: op.validadeMin,
        varredura_min: org(req).sessoes_minutos,
        // Dito em todo lugar que mostra bolinha verde: o estado vem da leitura do concentrador, e nada mais.
        explicacao: org(req).sessoes_minutos
          ? `O estado vem da varredura das sessões do concentrador, a cada ${org(req).sessoes_minutos} min. Leitura com mais de ${op.validadeMin} min deixa de valer como "agora".`
          : 'A varredura de sessões está desligada: o estado vem apenas da releitura do provisionamento, que é muito mais espaçada.',
      },
    });
  });

  r.get('/camadas', exigir('panorama.ver'), (req, res) => {
    res.json({ rede: pano.rede(db, req.org), chamados: pano.chamados(db, req.org) });
  });

  r.get('/filtros', exigir('panorama.ver'), (req, res) => res.json(pano.opcoesDeFiltro(db, req.org)));

  r.get('/resumo', exigir('panorama.ver'), (req, res) => {
    const op = opcoes(req);
    const d = pano.pontos(db, req.org, {}, op);
    const e = d.por_estado;
    const semLeitura = (e.nunca_lido ?? 0) + (e.leitura_antiga ?? 0);
    res.json({
      total: d.total,
      no_mapa: d.no_mapa,
      sem_coordenada: d.sem_coordenada,
      por_estado: e,
      // O número que o NOC olha primeiro: contrato ativo que deveria estar no ar e não está.
      sem_conexao: e.sem_conexao ?? 0,
      conectados: e.conectado ?? 0,
      sem_leitura: semLeitura,
      precisa_atencao: d.pontos.filter((p) => p.atencao).length,
      cobertura_leitura: d.total ? Math.round(((d.total - semLeitura - (e.nunca_lido ?? 0)) / d.total) * 100) : 0,
      varredura_min: org(req).sessoes_minutos,
      validade_min: op.validadeMin,
    });
  });

  /** Quem está fora do mapa por falta de coordenada: o mapa não pode esconder parte da carteira em silêncio. */
  r.get('/sem-coordenada', exigir('panorama.ver'), (req, res) => {
    const d = pano.pontos(db, req.org, { incluir_cancelados: false }, opcoes(req));
    res.json({ total: d.sem_coordenada, itens: d.fora_do_mapa });
  });

  // ---------------- Ponto ----------------
  r.get('/contratos/:id', exigir('panorama.ver'), (req, res) => {
    const op = opcoes(req);
    const d = pano.pontos(db, req.org, { incluir_cancelados: true }, op);
    const ponto = [...d.pontos, ...d.fora_do_mapa].find((p) => p.contrato_id === Number(req.params.id));
    if (!ponto) throw new ErroNegocio('Contrato não encontrado.', 404);
    res.json({
      ...ponto,
      historico: ponto.servico_id ? conexao.historico(db, ponto.servico_id, 20) : [],
    });
  });

  /** Pede uma leitura agora deste serviço. Não bloqueia: entra na fila e a tela diz isso. */
  r.post('/contratos/:id/ler', exigir('panorama.ver'), (req, res) => {
    const s = db.prepare(`SELECT s.* FROM servicos s JOIN contratos c ON c.id = s.contrato_id
      WHERE c.id = ? AND c.organizacao_id = ?`).get(Number(req.params.id), req.org);
    if (!s) throw new ErroNegocio('Este contrato não tem serviço provisionado.', 404);
    const t = prov.enfileirar(db, { org: req.org, servicoId: s.id, acao: 'ler', origem: 'usuario', usuarioId: req.usuario.id });
    res.status(202).json({
      tarefa_id: t.id,
      ja_na_fila: Boolean(t.ja_na_fila),
      aviso: 'A leitura foi para a fila do provisionamento. O estado muda quando o concentrador responder — nada foi alterado agora.',
    });
  });

  // ---------------- Área ----------------
  r.post('/area', exigir('panorama.area'), (req, res) => {
    const b = req.body ?? {};
    res.json(pano.impacto(db, req.org, b.area, filtrosDe(b.filtros ?? {}), opcoes(req)));
  });

  r.post('/area/csv', exigir('panorama.area'), (req, res) => {
    const b = req.body ?? {};
    const d = pano.impacto(db, req.org, b.area, filtrosDe(b.filtros ?? {}), opcoes(req));
    const linhas = [['Contrato', 'Assinante', 'Telefone', 'Endereço', 'Bairro', 'Plano', 'CTO', 'Estado', 'Desde', 'Quedas hoje'],
      ...d.itens.map((p) => [p.contrato_numero, p.assinante_nome, p.telefone ?? '', p.endereco ?? '', p.bairro ?? '',
        p.plano_nome, p.cto_codigo ?? '', p.estado, p.desde ?? '', p.quedas_hoje])];
    registrar(db, req, 'panorama_area_exportada', { recurso: 'panorama', depois: { assinantes: d.assinantes } });
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="area-panorama.csv"' }).send(csv(linhas));
  });

  /** Abre um incidente no NOC já com a conta do estrago: quem está dentro da área e quanto isso vale. */
  r.post('/area/incidente', exigir('panorama.area'), (req, res) => {
    const b = req.body ?? {};
    const d = pano.impacto(db, req.org, b.area, filtrosDe(b.filtros ?? {}), opcoes(req));
    const titulo = v.texto(b.titulo, 'o título', 160);
    const severidade = v.opcao(b.severidade ?? 'alta', 'a severidade', ['critica', 'alta', 'media', 'baixa']);
    let ativoId = null;
    if (b.ativo_id) {
      ativoId = db.prepare('SELECT id FROM ativos_rede WHERE id = ? AND organizacao_id = ?').get(Number(b.ativo_id), req.org)?.id ?? null;
      if (!ativoId) throw new ErroNegocio('Ativo não encontrado.', 422);
    }
    const t = agora();
    const evidencias = {
      origem: 'panorama',
      area: pano.validarPoligono(b.area),
      assinantes_na_area: d.assinantes,
      sem_conexao: d.sem_conexao,
      sem_leitura: d.sem_leitura,
      mensalidade_centavos: d.mensalidade_centavos,
      ctos: d.ctos,
      registro: v.opcional(b.descricao, 'a descrição', 1000),
    };
    const id = transacao(db, () => {
      const nid = Number(db.prepare(`INSERT INTO incidentes (organizacao_id, chave_dedup, origem, ativo_id, titulo, severidade,
        primeira_observacao, ultima_observacao, inicio, causa_provavel, responsavel_id, evidencias, criado_em, atualizado_em)
        VALUES (?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(req.org, `panorama:${t}:${Math.random()}`, ativoId, titulo, severidade, t, t, t,
          v.opcional(b.causa_provavel, 'a causa provável', 500), req.usuario.id, JSON.stringify(evidencias), t, t).lastInsertRowid);
      noc.evento(db, nid, 'aberto', `Aberto pelo Panorama a partir de uma área com ${d.assinantes} assinante(s), `
        + `${d.sem_conexao} sem conexão. Por ${req.usuario.nome}.`, req.usuario.id);
      noc.correlacionar(db, db.prepare('SELECT * FROM incidentes WHERE id = ?').get(nid));
      return nid;
    });
    registrar(db, req, 'incidente_criado', { recurso: 'incidente', recursoId: id, depois: { origem: 'panorama', titulo, severidade, assinantes: d.assinantes } });
    res.status(201).json({
      id,
      impacto: { assinantes: d.assinantes, sem_conexao: d.sem_conexao, sem_leitura: d.sem_leitura, mensalidade_centavos: d.mensalidade_centavos },
      aviso: d.sem_leitura
        ? `${d.sem_leitura} assinante(s) da área não têm leitura recente: o impacto real pode ser maior do que o registrado.`
        : null,
    });
  });

  // ---------------- Viabilidade ----------------
  r.get('/viabilidade', exigir('panorama.ver'), (req, res) => {
    res.json(pano.viabilidade(db, req.org, {
      lat: req.query.lat, lng: req.query.lng,
      raio_m: req.query.raio_m, limite: req.query.limite,
    }));
  });

  // ---------------- Mapa de calor ----------------
  r.get('/calor', exigir('panorama.ver'), (req, res) => {
    const o = org(req);
    const dias = Math.min(Math.max(Number(req.query.dias) || 7, 1), 90);
    const hoje = dataLocal(o.fuso);
    res.json(pano.calor(db, req.org, {
      de: req.query.de ? `${v.data(req.query.de, 'a data inicial')}T00:00:00.000Z` : `${somarDias(hoje, -dias)}T00:00:00.000Z`,
      ate: req.query.ate ? `${v.data(req.query.ate, 'a data final')}T23:59:59.999Z` : new Date().toISOString(),
      celula_m: req.query.celula_m,
      fuso: o.fuso,
    }));
  });

  // ---------------- Varredura sob demanda ----------------
  r.post('/varredura', exigir('panorama.area'), async (req, res) => {
    const alvos = prov.concentradoresVarreveis(db, req.org);
    if (!alvos.length) {
      throw new ErroNegocio('Nenhum concentrador com driver que saiba listar sessões e com carteira associada.', 422);
    }
    const resultados = [];
    for (const eq of alvos) {
      const x = await prov.varrerSessoes(db, req.org, eq.id);
      resultados.push({ equipamento: eq.nome, ...x });
    }
    const ok = resultados.filter((x) => x.ok);
    registrar(db, req, 'panorama_varredura', { recurso: 'panorama', depois: { concentradores: alvos.length, ok: ok.length } });
    res.json({
      concentradores: resultados,
      servicos: ok.reduce((s, x) => s + (x.servicos ?? 0), 0),
      caiu: ok.reduce((s, x) => s + (x.caiu ?? 0), 0),
      voltou: ok.reduce((s, x) => s + (x.voltou ?? 0), 0),
      aviso: resultados.some((x) => !x.ok)
        ? 'Algum concentrador não respondeu. Os assinantes dele ficaram como estavam — equipamento mudo não é prova de que ninguém está conectado.'
        : null,
    });
  });

  return r;
};
