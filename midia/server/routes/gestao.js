'use strict';

const { Router } = require('express');
const QRCode = require('qrcode');
const { agora, transacao, lerConfig, gravarConfig, CONFIG_PADRAO, TEXTO } = require('../db');
const { permitir } = require('../auth');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { hashSenha } = require('../lib/senha');
const { hoje, mes, somarDias, somarMeses, inicioMes, fimMes } = require('../lib/datas');
const { diagnostico, estaOnline } = require('../lib/monitor');
const rel = require('../lib/relatorios');
const faturamento = require('../lib/faturamento');
const exibicoes = require('../lib/exibicoes');
const v = require('../lib/validacao');

module.exports = (db) => {
  const r = Router();
  const cfg = () => lerConfig(db);

  // ----------------------------------------------------------------- Visão geral
  r.get('/resumo', (_req, res) => {
    const c = cfg();
    const data = hoje();
    const competencia = mes(data);
    const limite = new Date(Date.now() - c.offline_minutos * 60_000).toISOString();
    const telas = db.prepare("SELECT * FROM telas WHERE status <> 'inativa'").all();
    const online = telas.filter((t) => t.ultimo_contato && t.ultimo_contato > limite);

    const doDia = db.prepare(`SELECT COALESCE(SUM(insercoes), 0) AS insercoes, COALESCE(SUM(segundos), 0) AS segundos,
      COALESCE(SUM(CASE WHEN campanha_id <> 0 THEN insercoes ELSE 0 END), 0) AS insercoes_pagas FROM resumo_dia WHERE data = ?`).get(data);
    const doMes = rel.porCampanha(db, { de: inicioMes(competencia), ate: fimMes(competencia) });
    const previsao = faturamento.calcular(db, competencia);

    res.json({
      competencia,
      telas: {
        total: telas.length,
        online: online.length,
        offline: telas.filter((t) => t.pareada_em && !(t.ultimo_contato > limite)).length,
        sem_parear: telas.filter((t) => !t.pareada_em).length,
        manutencao: telas.filter((t) => t.status === 'manutencao').length,
      },
      pontos: db.prepare("SELECT COUNT(*) AS total, COUNT(DISTINCT cidade) AS cidades FROM locais WHERE status = 'ativo'").get(),
      publico_dia: db.prepare("SELECT COALESCE(SUM(publico_dia), 0) AS n FROM locais WHERE status = 'ativo'").get().n,
      hoje: doDia,
      campanhas: db.prepare(`SELECT
          COALESCE(SUM(status = 'ativa'), 0) AS ativas,
          COALESCE(SUM(status = 'aguardando'), 0) AS aguardando,
          COALESCE(SUM(status = 'pausada'), 0) AS pausadas,
          COALESCE(SUM(status = 'rascunho'), 0) AS rascunhos FROM campanhas`).get(),
      midias_pendentes: db.prepare("SELECT COUNT(*) AS n FROM midias WHERE status = 'pendente'").get().n,
      mes: {
        insercoes: doMes.reduce((t, x) => t + x.insercoes, 0),
        impactos: doMes.reduce((t, x) => t + x.impactos, 0),
        receita_prevista_centavos: previsao.reduce((t, x) => t + x.valor_centavos, 0),
        anunciantes: previsao.length,
      },
      faturas: db.prepare(`SELECT COALESCE(SUM(status = 'aberta'), 0) AS abertas,
          COALESCE(SUM(CASE WHEN status = 'aberta' THEN valor_centavos ELSE 0 END), 0) AS aberto_centavos,
          COALESCE(SUM(status = 'aberta' AND vencimento < ?), 0) AS atrasadas FROM faturas`).get(data),
      repasses: db.prepare(`SELECT COALESCE(SUM(status = 'a_pagar'), 0) AS a_pagar,
          COALESCE(SUM(CASE WHEN status = 'a_pagar' THEN valor_centavos ELSE 0 END), 0) AS valor_centavos FROM repasses`).get(),
      por_dia: rel.porDia(db, { de: somarDias(data, -13), ate: data }),
      top_campanhas: doMes.slice(0, 8),
      top_pontos: rel.porLocal(db, { de: inicioMes(competencia), ate: fimMes(competencia) }).slice(0, 8),
      alertas: diagnostico(db).verificacoes.filter((x) => !x.ok),
    });
  });

  r.get('/diagnostico', (_req, res) => res.json(diagnostico(db)));

  // ----------------------------------------------------------------- Relatórios
  r.get('/relatorios/campanhas', (req, res) => {
    const p = rel.periodo(req.query);
    const itens = rel.porCampanha(db, { ...p, anuncianteId: req.query.anunciante_id ? Number(req.query.anunciante_id) : null });
    if (req.query.csv) {
      return rel.enviarCsv(res, `campanhas-${p.de}-${p.ate}.csv`, rel.csv([['anunciante', 'Anunciante'], ['campanha', 'Campanha'], ['status', 'Situação'],
        ['insercoes', 'Inserções'], ['segundos', 'Tempo no ar (s)'], ['telas', 'TVs'], ['pontos', 'Pontos'], ['impactos', 'Impactos']], itens));
    }
    res.json({ ...p, itens });
  });

  r.get('/relatorios/telas', (req, res) => {
    const p = rel.periodo(req.query);
    const itens = rel.porTela(db, { ...p, localId: req.query.local_id ? Number(req.query.local_id) : null });
    if (req.query.csv) {
      return rel.enviarCsv(res, `telas-${p.de}-${p.ate}.csv`, rel.csv([['tela', 'TV'], ['local', 'Ponto'], ['cidade', 'Cidade'], ['categoria', 'Categoria'],
        ['insercoes', 'Inserções'], ['insercoes_pagas', 'Inserções pagas'], ['segundos', 'Tempo no ar (s)'], ['ocupacao', 'Ocupação (%)'], ['dias', 'Dias com exibição']], itens));
    }
    res.json({ ...p, itens });
  });

  r.get('/relatorios/pontos', (req, res) => {
    const p = rel.periodo(req.query);
    const itens = rel.porLocal(db, p);
    if (req.query.csv) {
      return rel.enviarCsv(res, `pontos-${p.de}-${p.ate}.csv`, rel.csv([['local', 'Ponto'], ['cidade', 'Cidade'], ['uf', 'UF'], ['categoria', 'Categoria'],
        ['telas', 'TVs'], ['publico_dia', 'Público/dia'], ['insercoes', 'Inserções'], ['insercoes_pagas', 'Inserções pagas'], ['impactos', 'Impactos'],
        [(l) => (l.comissao_percentual / 100).toFixed(2).replace('.', ','), 'Comissão (%)']], itens));
    }
    res.json({ ...p, itens });
  });

  r.get('/relatorios/dias', (req, res) => {
    const p = rel.periodo(req.query);
    res.json({ ...p, itens: rel.porDia(db, { ...p, campanhaId: req.query.campanha_id ? Number(req.query.campanha_id) : null, telaId: req.query.tela_id ? Number(req.query.tela_id) : null }) });
  });

  r.get('/relatorios/horas', (req, res) => {
    const p = rel.periodo(req.query);
    res.json({ ...p, itens: rel.porHora(db, { ...p, telaId: req.query.tela_id ? Number(req.query.tela_id) : null }) });
  });

  /** Prova de exibição: o relatório que o anunciante recebe (cada vez que o anúncio foi ao ar). */
  r.get('/relatorios/prova', (req, res) => {
    const p = rel.periodo(req.query);
    const filtros = {
      ...p,
      campanhaId: req.query.campanha_id ? Number(req.query.campanha_id) : null,
      telaId: req.query.tela_id ? Number(req.query.tela_id) : null,
      anuncianteId: req.query.anunciante_id ? Number(req.query.anunciante_id) : null,
      localId: req.query.local_id ? Number(req.query.local_id) : null,
      pagina: Math.max(1, Number(req.query.pagina) || 1),
      limite: req.query.csv ? 20000 : Math.min(500, Number(req.query.limite) || 200),
    };
    const dados = rel.prova(db, filtros);
    if (req.query.csv) return rel.enviarCsv(res, `prova-de-exibicao-${p.de}-${p.ate}.csv`, rel.csv(rel.COLUNAS_PROVA, dados.itens));
    res.json(dados);
  });

  /** Recalcula o resumo de um dia a partir das exibições (manutenção). */
  r.post('/relatorios/recalcular', permitir('master'), (req, res) => {
    const data = v.data(req.body.data, 'a data');
    const linhas = exibicoes.recalcularDia(db, data);
    registrar(db, req, 'resumo_recalculado', { data, linhas });
    res.json({ data, linhas });
  });

  // ----------------------------------------------------------------- Faturamento e repasses
  r.get('/faturamento', (req, res) => {
    const competencia = req.query.competencia ? v.competencia(req.query.competencia) : somarMeses(mes(), -1);
    const previa = faturamento.calcular(db, competencia);
    res.json({
      competencia,
      previa,
      total_centavos: previa.reduce((t, f) => t + f.valor_centavos, 0),
      repasses: faturamento.calcularRepasses(db, competencia, previa),
      faturas: db.prepare(`SELECT f.*, a.nome AS anunciante FROM faturas f JOIN anunciantes a ON a.id = f.anunciante_id WHERE f.competencia = ? ORDER BY f.valor_centavos DESC`)
        .all(competencia),
      gravados: db.prepare('SELECT COUNT(*) AS n FROM faturas WHERE competencia = ?').get(competencia).n,
    });
  });

  r.post('/faturamento/gerar', (req, res) => {
    const competencia = v.competencia(req.body.competencia);
    if (competencia > mes()) throw new ErroNegocio('Não é possível fechar uma competência futura.', 422);
    const resultado = faturamento.gerar(db, competencia, { vencimento: req.body.vencimento ? v.data(req.body.vencimento, 'o vencimento') : null });
    registrar(db, req, 'faturamento_gerado', resultado);
    res.status(201).json(resultado);
  });

  r.get('/faturas', (req, res) => {
    const onde = [];
    const p = [];
    if (req.query.status) { onde.push('f.status = ?'); p.push(req.query.status); }
    if (req.query.anunciante_id) { onde.push('f.anunciante_id = ?'); p.push(Number(req.query.anunciante_id)); }
    if (req.query.competencia) { onde.push('f.competencia = ?'); p.push(v.competencia(req.query.competencia)); }
    const itens = db.prepare(`SELECT f.*, a.nome AS anunciante, (f.status = 'aberta' AND f.vencimento < ?) AS atrasada
      FROM faturas f JOIN anunciantes a ON a.id = f.anunciante_id ${onde.length ? `WHERE ${onde.join(' AND ')}` : ''}
      ORDER BY f.competencia DESC, a.nome`).all(hoje(), ...p);
    res.json({
      itens,
      totais: {
        aberto_centavos: itens.filter((f) => f.status === 'aberta').reduce((t, f) => t + f.valor_centavos, 0),
        pago_centavos: itens.filter((f) => f.status === 'paga').reduce((t, f) => t + f.valor_centavos, 0),
        atrasadas: itens.filter((f) => f.atrasada).length,
      },
    });
  });

  r.get('/faturas/:id', async (req, res) => {
    const f = faturamento.detalhe(db, Number(req.params.id));
    if (f.pix) f.pix.qr = await QRCode.toDataURL(f.pix.codigo, { margin: 1, width: 320 }).catch(() => null);
    res.json(f);
  });

  r.post('/faturas/:id/pagar', (req, res) => {
    const id = Number(req.params.id);
    const f = db.prepare('SELECT * FROM faturas WHERE id = ?').get(id);
    if (!f) throw naoEncontrado('Fatura');
    if (f.status !== 'aberta') throw new ErroNegocio('Esta fatura não está aberta.', 409);
    const pago = req.body.pago_em ? v.data(req.body.pago_em, 'a data do pagamento') : hoje();
    db.prepare("UPDATE faturas SET status = 'paga', pago_em = ?, observacao = COALESCE(?, observacao) WHERE id = ?")
      .run(pago, v.opcional(req.body.observacao, 'a observação', 300), id);
    registrar(db, req, 'fatura_paga', { id, valor_centavos: f.valor_centavos, pago_em: pago });
    res.json(db.prepare('SELECT * FROM faturas WHERE id = ?').get(id));
  });

  r.post('/faturas/:id/cancelar', (req, res) => {
    const id = Number(req.params.id);
    const f = db.prepare('SELECT * FROM faturas WHERE id = ?').get(id);
    if (!f) throw naoEncontrado('Fatura');
    if (f.status === 'paga') throw new ErroNegocio('Fatura paga não pode ser cancelada.', 409);
    db.prepare("UPDATE faturas SET status = 'cancelada', observacao = ? WHERE id = ?").run(v.texto(req.body.motivo, 'o motivo', 300), id);
    registrar(db, req, 'fatura_cancelada', { id });
    res.json(db.prepare('SELECT * FROM faturas WHERE id = ?').get(id));
  });

  r.get('/repasses', (req, res) => {
    const onde = [];
    const p = [];
    if (req.query.status) { onde.push('r.status = ?'); p.push(req.query.status); }
    if (req.query.competencia) { onde.push('r.competencia = ?'); p.push(v.competencia(req.query.competencia)); }
    if (req.query.local_id) { onde.push('r.local_id = ?'); p.push(Number(req.query.local_id)); }
    const itens = db.prepare(`SELECT r.*, l.nome AS local, l.cidade, l.responsavel, l.telefone FROM repasses r JOIN locais l ON l.id = r.local_id
      ${onde.length ? `WHERE ${onde.join(' AND ')}` : ''} ORDER BY r.competencia DESC, r.valor_centavos DESC`).all(...p);
    res.json({ itens, total_centavos: itens.filter((x) => x.status === 'a_pagar').reduce((t, x) => t + x.valor_centavos, 0) });
  });

  r.post('/repasses/:id/pagar', (req, res) => {
    const id = Number(req.params.id);
    const x = db.prepare('SELECT * FROM repasses WHERE id = ?').get(id);
    if (!x) throw naoEncontrado('Repasse');
    if (x.status !== 'a_pagar') throw new ErroNegocio('Este repasse não está a pagar.', 409);
    db.prepare("UPDATE repasses SET status = 'pago', pago_em = ?, observacao = COALESCE(?, observacao) WHERE id = ?")
      .run(req.body.pago_em ? v.data(req.body.pago_em, 'a data do pagamento') : hoje(), v.opcional(req.body.observacao, 'a observação', 300), id);
    registrar(db, req, 'repasse_pago', { id, valor_centavos: x.valor_centavos });
    res.json(db.prepare('SELECT * FROM repasses WHERE id = ?').get(id));
  });

  // ----------------------------------------------------------------- Usuários, configurações e histórico
  r.get('/usuarios', permitir('master'), (_req, res) => {
    res.json({
      itens: db.prepare(`SELECT u.id, u.nome, u.email, u.perfil, u.ativo, u.ultimo_acesso, u.criado_em, a.nome AS anunciante, l.nome AS ponto
        FROM usuarios u LEFT JOIN anunciantes a ON a.id = u.anunciante_id LEFT JOIN locais l ON l.id = u.local_id ORDER BY u.perfil, u.nome`).all(),
    });
  });

  r.post('/usuarios', permitir('master'), (req, res) => {
    const perfil = v.opcao(req.body.perfil, 'o perfil', ['master', 'operador', 'anunciante', 'lojista']);
    const d = { nome: v.texto(req.body.nome, 'o nome', 120), email: v.email(req.body.email), senha_hash: hashSenha(v.senha(req.body.senha)), perfil };
    if (perfil === 'anunciante') {
      d.anunciante_id = Number(req.body.anunciante_id);
      if (!db.prepare('SELECT 1 FROM anunciantes WHERE id = ?').get(d.anunciante_id)) throw new ErroNegocio('Informe o anunciante deste acesso.', 422);
    }
    if (perfil === 'lojista') {
      d.local_id = Number(req.body.local_id);
      if (!db.prepare('SELECT 1 FROM locais WHERE id = ?').get(d.local_id)) throw new ErroNegocio('Informe o ponto deste acesso.', 422);
    }
    const id = Number(db.prepare(`INSERT INTO usuarios (${Object.keys(d).join(', ')}, criado_em) VALUES (${Object.keys(d).map(() => '?').join(', ')}, ?)`)
      .run(...Object.values(d), agora()).lastInsertRowid);
    registrar(db, req, 'usuario_criado', { id, perfil, email: d.email });
    res.status(201).json({ id, nome: d.nome, email: d.email, perfil });
  });

  r.patch('/usuarios/:id', permitir('master'), (req, res) => {
    const id = Number(req.params.id);
    const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
    if (!u) throw naoEncontrado('Usuário');
    const d = {};
    if (req.body.nome !== undefined) d.nome = v.texto(req.body.nome, 'o nome', 120);
    if (req.body.email !== undefined) d.email = v.email(req.body.email);
    if (req.body.senha !== undefined) d.senha_hash = hashSenha(v.senha(req.body.senha));
    if (req.body.ativo !== undefined) d.ativo = v.booleano(req.body.ativo) ? 1 : 0;
    if (req.body.perfil !== undefined && ['master', 'operador'].includes(u.perfil)) d.perfil = v.opcao(req.body.perfil, 'o perfil', ['master', 'operador']);
    if (!Object.keys(d).length) throw new ErroNegocio('Nada para alterar.', 422);
    // Sempre precisa sobrar um master ativo.
    if ((d.ativo === 0 || (d.perfil && d.perfil !== 'master')) && u.perfil === 'master') {
      const outros = db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE perfil = 'master' AND ativo = 1 AND id <> ?").get(id).n;
      if (!outros) throw new ErroNegocio('Precisa existir pelo menos um master ativo.', 409);
    }
    db.prepare(`UPDATE usuarios SET ${Object.keys(d).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(d), id);
    registrar(db, req, 'usuario_alterado', { id, campos: Object.keys(d) });
    res.json(db.prepare('SELECT id, nome, email, perfil, ativo FROM usuarios WHERE id = ?').get(id));
  });

  r.get('/configuracoes', permitir('master'), (_req, res) => res.json({ ...cfg(), padroes: CONFIG_PADRAO }));

  r.put('/configuracoes', permitir('master'), (req, res) => {
    const limites = {
      duracao_imagem_s: [3, 120], insercoes_hora_padrao: [1, 120], bloco_minimo_s: [30, 3600], bloco_maximo_s: [60, 7200],
      batida_intervalo_s: [15, 900], offline_minutos: [2, 1440], mensalidade_tela_centavos: [0, 1_000_000_00], cpm_centavos: [0, 1_000_000],
      comissao_local_percentual: [0, 10_000], vencimento_dia: [1, 28], aviso_lojista: [0, 1], prova_dias: [0, 3650],
    };
    transacao(db, () => {
      for (const [k] of Object.entries(CONFIG_PADRAO)) {
        if (req.body[k] === undefined) continue;
        if (TEXTO.has(k)) {
          gravarConfig(db, k, k === 'nome_plataforma' ? v.texto(req.body[k], 'o nome da plataforma', 60) : (v.opcional(req.body[k], k, 80) ?? ''));
        } else {
          const [min, max] = limites[k];
          gravarConfig(db, k, v.inteiro(req.body[k], k.replace(/_/g, ' '), { min, max }));
        }
      }
      if (lerConfig(db).bloco_minimo_s > lerConfig(db).bloco_maximo_s) throw new ErroNegocio('O tempo mínimo do loop não pode ser maior que o máximo.', 422);
    });
    registrar(db, req, 'configuracoes_alteradas', { campos: Object.keys(req.body) });
    res.json(cfg());
  });

  r.get('/auditoria', (req, res) => {
    const onde = [];
    const p = [];
    if (req.query.acao) { onde.push('a.acao LIKE ?'); p.push(`%${req.query.acao}%`); }
    if (req.query.usuario_id) { onde.push('a.usuario_id = ?'); p.push(Number(req.query.usuario_id)); }
    const limite = Math.min(500, Number(req.query.limite) || 100);
    res.json({
      itens: db.prepare(`SELECT a.*, u.nome AS usuario FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id
        ${onde.length ? `WHERE ${onde.join(' AND ')}` : ''} ORDER BY a.id DESC LIMIT ?`).all(...p, limite),
    });
  });

  /** Lista enxuta para preencher seletores (anunciantes, pontos e telas). */
  r.get('/opcoes', (_req, res) => {
    const c = cfg();
    res.json({
      anunciantes: db.prepare("SELECT id, nome FROM anunciantes WHERE status = 'ativo' ORDER BY nome").all(),
      locais: db.prepare("SELECT id, nome, cidade, categoria FROM locais WHERE status <> 'encerrado' ORDER BY nome").all(),
      telas: db.prepare(`SELECT t.id, t.nome, t.orientacao, t.local_id, l.nome AS local_nome, t.ultimo_contato FROM telas t JOIN locais l ON l.id = t.local_id
        WHERE t.status <> 'inativa' ORDER BY l.nome, t.nome`).all().map((t) => ({ ...t, online: estaOnline(t, c) })),
      cidades: db.prepare("SELECT DISTINCT cidade FROM locais WHERE cidade <> '' ORDER BY cidade").all().map((x) => x.cidade),
      competencias: db.prepare('SELECT DISTINCT substr(data, 1, 7) AS competencia FROM resumo_dia ORDER BY competencia DESC LIMIT 24').all().map((x) => x.competencia),
    });
  });

  return r;
};
