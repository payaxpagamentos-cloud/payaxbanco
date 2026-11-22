'use strict';

const { Router } = require('express');
const QRCode = require('qrcode');
const { agora, transacao, lerConfig, gravarConfig, CONFIG_PADRAO, TEXTO } = require('../db');
const { permitir, EQUIPE } = require('../auth');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { hashSenha, verificarSenha } = require('../lib/senha');
const atualizacao = require('../lib/atualizacao');
const empresas = require('../lib/empresas');
const { hoje, mes, somarDias, somarMeses, inicioMes, fimMes, minutosDe } = require('../lib/datas');
const { diagnostico, estaOnline } = require('../lib/monitor');
const grade = require('../lib/grade');
const propostasLib = require('../lib/propostas');
const rel = require('../lib/relatorios');
const faturamento = require('../lib/faturamento');
const backup = require('../lib/backup');
const emailLib = require('../lib/email');
const avisos = require('../lib/avisos');
const exibicoes = require('../lib/exibicoes');
const v = require('../lib/validacao');

module.exports = (db) => {
  const r = Router();
  const cfg = () => lerConfig(db);

  // ----------------------------------------------------------------- Visão geral
  r.get('/resumo', (req, res) => {
    const c = cfg();
    const data = hoje();
    const competencia = mes(data);
    const limite = new Date(Date.now() - c.offline_minutos * 60_000).toISOString();
    // Tudo da empresa de quem olha (o master vê a rede inteira).
    const E = empresas.empresaDe(req);
    const ep = E === null ? [] : [E];
    const locE = E === null ? '' : ' AND empresa_id = ?';
    const telaE = E === null ? '' : ' AND local_id IN (SELECT id FROM locais WHERE empresa_id = ?)';
    const anunE = E === null ? '' : ' AND anunciante_id IN (SELECT id FROM anunciantes WHERE empresa_id = ?)';
    const telas = db.prepare(`SELECT * FROM telas WHERE status <> 'inativa'${telaE}`).all(...ep);
    const online = telas.filter((t) => t.ultimo_contato && t.ultimo_contato > limite);

    const doDia = db.prepare(`SELECT COALESCE(SUM(insercoes), 0) AS insercoes, COALESCE(SUM(segundos), 0) AS segundos,
      COALESCE(SUM(CASE WHEN campanha_id <> 0 THEN insercoes ELSE 0 END), 0) AS insercoes_pagas FROM resumo_dia WHERE data = ?${telaE}`).get(data, ...ep);
    const doMes = rel.porCampanha(db, { de: inicioMes(competencia), ate: fimMes(competencia), empresaId: E });
    const previsao = faturamento.calcular(db, competencia, { empresaId: E });

    res.json({
      competencia,
      telas: {
        total: telas.length,
        online: online.length,
        offline: telas.filter((t) => t.pareada_em && !(t.ultimo_contato > limite)).length,
        sem_parear: telas.filter((t) => !t.pareada_em).length,
        manutencao: telas.filter((t) => t.status === 'manutencao').length,
      },
      pontos: db.prepare(`SELECT COUNT(*) AS total, COUNT(DISTINCT cidade) AS cidades FROM locais WHERE status = 'ativo'${locE}`).get(...ep),
      publico_dia: db.prepare(`SELECT COALESCE(SUM(publico_dia), 0) AS n FROM locais WHERE status = 'ativo'${locE}`).get(...ep).n,
      hoje: doDia,
      campanhas: db.prepare(`SELECT
          COALESCE(SUM(status = 'ativa'), 0) AS ativas,
          COALESCE(SUM(status = 'aguardando'), 0) AS aguardando,
          COALESCE(SUM(status = 'pausada'), 0) AS pausadas,
          COALESCE(SUM(status = 'rascunho'), 0) AS rascunhos FROM campanhas WHERE 1 = 1${anunE}`).get(...ep),
      midias_pendentes: db.prepare(`SELECT COUNT(*) AS n FROM midias WHERE status = 'pendente'${locE}`).get(...ep).n,
      mes: {
        insercoes: doMes.reduce((t, x) => t + x.insercoes, 0),
        impactos: doMes.reduce((t, x) => t + x.impactos, 0),
        receita_prevista_centavos: previsao.reduce((t, x) => t + x.valor_centavos, 0),
        anunciantes: previsao.length,
      },
      faturas: db.prepare(`SELECT COALESCE(SUM(status = 'aberta'), 0) AS abertas,
          COALESCE(SUM(CASE WHEN status = 'aberta' THEN valor_centavos ELSE 0 END), 0) AS aberto_centavos,
          COALESCE(SUM(status = 'aberta' AND vencimento < ?), 0) AS atrasadas FROM faturas WHERE 1 = 1${anunE}`).get(data, ...ep),
      repasses: db.prepare(`SELECT COALESCE(SUM(status = 'a_pagar'), 0) AS a_pagar,
          COALESCE(SUM(CASE WHEN status = 'a_pagar' THEN valor_centavos ELSE 0 END), 0) AS valor_centavos FROM repasses WHERE 1 = 1${telaE}`).get(...ep),
      por_dia: rel.porDia(db, { de: somarDias(data, -13), ate: data, empresaId: E }),
      top_campanhas: doMes.slice(0, 8),
      top_pontos: rel.porLocal(db, { de: inicioMes(competencia), ate: fimMes(competencia), empresaId: E }).slice(0, 8),
      alertas: diagnostico(db, { empresaId: E }).verificacoes.filter((x) => !x.ok),
    });
  });

  r.get('/diagnostico', (req, res) => res.json(diagnostico(db, { empresaId: empresas.empresaDe(req) })));

  // ----------------------------------------------------------------- Relatórios
  r.get('/relatorios/campanhas', (req, res) => {
    const p = rel.periodo(req.query);
    const itens = rel.porCampanha(db, { ...p, anuncianteId: req.query.anunciante_id ? Number(req.query.anunciante_id) : null, empresaId: empresas.empresaDe(req) });
    if (req.query.csv) {
      return rel.enviarCsv(res, `campanhas-${p.de}-${p.ate}.csv`, rel.csv([['anunciante', 'Anunciante'], ['campanha', 'Campanha'], ['status', 'Situação'],
        ['insercoes', 'Inserções'], ['segundos', 'Tempo no ar (s)'], ['telas', 'TVs'], ['pontos', 'Pontos'], ['impactos', 'Impactos']], itens));
    }
    res.json({ ...p, itens });
  });

  r.get('/relatorios/telas', (req, res) => {
    const p = rel.periodo(req.query);
    const itens = rel.porTela(db, { ...p, localId: req.query.local_id ? Number(req.query.local_id) : null, empresaId: empresas.empresaDe(req) });
    if (req.query.csv) {
      return rel.enviarCsv(res, `telas-${p.de}-${p.ate}.csv`, rel.csv([['tela', 'TV'], ['local', 'Ponto'], ['cidade', 'Cidade'], ['categoria', 'Categoria'],
        ['insercoes', 'Inserções'], ['insercoes_pagas', 'Inserções pagas'], ['segundos', 'Tempo no ar (s)'], ['ocupacao', 'Ocupação (%)'], ['dias', 'Dias com exibição']], itens));
    }
    res.json({ ...p, itens });
  });

  r.get('/relatorios/pontos', (req, res) => {
    const p = rel.periodo(req.query);
    const itens = rel.porLocal(db, { ...p, empresaId: empresas.empresaDe(req) });
    if (req.query.csv) {
      return rel.enviarCsv(res, `pontos-${p.de}-${p.ate}.csv`, rel.csv([['local', 'Ponto'], ['cidade', 'Cidade'], ['uf', 'UF'], ['categoria', 'Categoria'],
        ['telas', 'TVs'], ['publico_dia', 'Público/dia'], ['insercoes', 'Inserções'], ['insercoes_pagas', 'Inserções pagas'], ['impactos', 'Impactos'],
        [(l) => (l.comissao_percentual / 100).toFixed(2).replace('.', ','), 'Comissão (%)']], itens));
    }
    res.json({ ...p, itens });
  });

  r.get('/relatorios/dias', (req, res) => {
    const p = rel.periodo(req.query);
    res.json({ ...p, itens: rel.porDia(db, { ...p, campanhaId: req.query.campanha_id ? Number(req.query.campanha_id) : null, telaId: req.query.tela_id ? Number(req.query.tela_id) : null, empresaId: empresas.empresaDe(req) }) });
  });

  r.get('/relatorios/horas', (req, res) => {
    const p = rel.periodo(req.query);
    res.json({ ...p, itens: rel.porHora(db, { ...p, telaId: req.query.tela_id ? Number(req.query.tela_id) : null, empresaId: empresas.empresaDe(req) }) });
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
      empresaId: empresas.empresaDe(req),
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

  // ----------------------------------------------------------------- Fechamento do mês
  // (as faturas, os repasses, os contratos e as despesas ficam em routes/financeiro.js)
  r.get('/faturamento', (req, res) => {
    const competencia = req.query.competencia ? v.competencia(req.query.competencia) : somarMeses(mes(), -1);
    const E = empresas.empresaDe(req);
    const [fe, fp] = empresas.filtro(req, 'a.empresa_id');
    const previa = faturamento.calcular(db, competencia, { empresaId: E });
    res.json({
      competencia,
      previa,
      total_centavos: previa.reduce((t, f) => t + f.valor_centavos, 0),
      repasses: faturamento.calcularRepasses(db, competencia, previa, { empresaId: E }),
      faturas: db.prepare(`SELECT f.*, a.nome AS anunciante FROM faturas f JOIN anunciantes a ON a.id = f.anunciante_id WHERE f.competencia = ?${fe} ORDER BY f.valor_centavos DESC`)
        .all(competencia, ...fp),
      gravados: db.prepare(`SELECT COUNT(*) AS n FROM faturas f JOIN anunciantes a ON a.id = f.anunciante_id WHERE f.competencia = ?${fe}`).get(competencia, ...fp).n,
    });
  });

  r.post('/faturamento/gerar', (req, res) => {
    const competencia = v.competencia(req.body.competencia);
    if (competencia > mes()) throw new ErroNegocio('Não é possível fechar uma competência futura.', 422);
    const resultado = faturamento.gerar(db, competencia, { vencimento: req.body.vencimento ? v.data(req.body.vencimento, 'o vencimento') : null, empresaId: empresas.empresaDe(req) });
    registrar(db, req, 'faturamento_gerado', resultado);
    res.status(201).json(resultado);
  });

  // ----------------------------------------------------------------- Agências
  r.get('/agencias', (req, res) => {
    const [fe, fp] = empresas.filtro(req, 'a.empresa_id');
    res.json({
      itens: db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM campanhas c WHERE c.agencia_id = a.id) AS campanhas,
          (SELECT COUNT(*) FROM campanhas c WHERE c.agencia_id = a.id AND c.status = 'ativa') AS campanhas_ativas
        FROM agencias a WHERE 1 = 1${fe} ORDER BY a.nome`).all(...fp),
    });
  });

  const lerAgencia = (c, parcial = false) => {
    const d = {};
    if (c.nome !== undefined || !parcial) d.nome = v.texto(c.nome, 'o nome da agência', 120);
    if (c.documento !== undefined) d.documento = c.documento === null || c.documento === '' ? null : v.documento(c.documento);
    if (c.contato !== undefined) d.contato = v.opcional(c.contato, 'o contato', 120);
    if (c.email !== undefined) d.email = c.email === null || c.email === '' ? null : v.email(c.email);
    if (c.telefone !== undefined) d.telefone = c.telefone === null || c.telefone === '' ? null : v.telefone(c.telefone);
    if (c.comissao_percentual !== undefined) d.comissao_percentual = v.percentual(c.comissao_percentual, 'a comissão da agência');
    if (c.status !== undefined) d.status = v.opcao(c.status, 'a situação', ['ativa', 'inativa']);
    return d;
  };

  r.post('/agencias', (req, res) => {
    const d = lerAgencia(req.body);
    d.empresa_id = empresas.empresaParaGravar(db, req, req.body.empresa_id);
    const id = Number(db.prepare(`INSERT INTO agencias (${Object.keys(d).join(', ')}, criado_em) VALUES (${Object.keys(d).map(() => '?').join(', ')}, ?)`)
      .run(...Object.values(d), agora()).lastInsertRowid);
    registrar(db, req, 'agencia_criada', { id, nome: d.nome });
    res.status(201).json({ id, ...d });
  });

  r.patch('/agencias/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM agencias WHERE id = ?').get(id)) throw naoEncontrado('Agência');
    const d = lerAgencia(req.body, true);
    if (!Object.keys(d).length) throw new ErroNegocio('Nada para alterar.', 422);
    db.prepare(`UPDATE agencias SET ${Object.keys(d).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(d), id);
    registrar(db, req, 'agencia_alterada', { id, depois: d });
    res.json(db.prepare('SELECT * FROM agencias WHERE id = ?').get(id));
  });

  // ----------------------------------------------------------------- Circuitos (o pacote que o comercial vende)
  // O cálculo do circuito (telas alcançadas, audiência) e o da proposta vivem em lib/propostas.js,
  // porque a proposta guardada precisa deles fora do contexto de uma requisição.
  const telasDoCircuito = (circuitoId) => propostasLib.telasDoCircuito(db, circuitoId);
  const resumoCircuito = (c) => propostasLib.resumoCircuito(db, c);

  r.get('/circuitos', (req, res) => {
    const [fe, fp] = empresas.filtro(req, 'empresa_id');
    res.json({ itens: db.prepare(`SELECT * FROM circuitos WHERE 1 = 1${fe} ORDER BY ativo DESC, nome`).all(...fp).map((c) => ({ ...resumoCircuito(c), lista: undefined })) });
  });

  r.get('/circuitos/:id', (req, res) => {
    const c = db.prepare('SELECT * FROM circuitos WHERE id = ?').get(Number(req.params.id));
    if (!c) throw naoEncontrado('Circuito');
    res.json({ ...resumoCircuito(c), alvos: db.prepare('SELECT id, tipo, valor FROM circuito_alvos WHERE circuito_id = ? ORDER BY tipo, valor').all(c.id) });
  });

  /** Prévia da proposta (não guarda nada): é o que o comercial vê antes de gerar. */
  r.get('/circuitos/:id/proposta', (req, res) => res.json(propostasLib.calcular(db, Number(req.params.id), req.query)));

  const lerCircuito = (c, parcial = false) => {
    const d = {};
    if (c.nome !== undefined || !parcial) d.nome = v.texto(c.nome, 'o nome do circuito', 120);
    if (c.descricao !== undefined) d.descricao = v.opcional(c.descricao, 'a descrição', 300);
    if (c.valor_mes_centavos !== undefined) d.valor_mes_centavos = v.inteiro(c.valor_mes_centavos, 'o valor por mês', { max: 1_000_000_000 });
    if (c.cpm_centavos !== undefined) d.cpm_centavos = v.inteiro(c.cpm_centavos, 'o CPM', { max: 1_000_000 });
    if (c.insercoes_hora !== undefined) d.insercoes_hora = v.inteiro(c.insercoes_hora, 'as inserções por hora', { min: 1, max: 120 });
    if (c.ativo !== undefined) d.ativo = v.booleano(c.ativo) ? 1 : 0;
    return d;
  };

  r.post('/circuitos', (req, res) => {
    const d = lerCircuito(req.body);
    const id = transacao(db, () => {
      d.empresa_id = empresas.empresaParaGravar(db, req, req.body.empresa_id);
      const novo = Number(db.prepare(`INSERT INTO circuitos (${Object.keys(d).join(', ')}, criado_em) VALUES (${Object.keys(d).map(() => '?').join(', ')}, ?)`)
        .run(...Object.values(d), agora()).lastInsertRowid);
      for (const a of req.body.alvos ?? []) {
        db.prepare('INSERT OR IGNORE INTO circuito_alvos (circuito_id, tipo, valor) VALUES (?, ?, ?)')
          .run(novo, v.opcao(a.tipo, 'o tipo de alvo', ['tela', 'local', 'categoria', 'cidade']), v.texto(a.valor, 'o alvo', 80));
      }
      return novo;
    });
    registrar(db, req, 'circuito_criado', { id, nome: d.nome });
    res.status(201).json({ id, ...d });
  });

  r.patch('/circuitos/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM circuitos WHERE id = ?').get(id)) throw naoEncontrado('Circuito');
    const d = lerCircuito(req.body, true);
    transacao(db, () => {
      if (Object.keys(d).length) db.prepare(`UPDATE circuitos SET ${Object.keys(d).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(d), id);
      if (Array.isArray(req.body.alvos)) {
        db.prepare('DELETE FROM circuito_alvos WHERE circuito_id = ?').run(id);
        for (const a of req.body.alvos) {
          db.prepare('INSERT OR IGNORE INTO circuito_alvos (circuito_id, tipo, valor) VALUES (?, ?, ?)')
            .run(id, v.opcao(a.tipo, 'o tipo de alvo', ['tela', 'local', 'categoria', 'cidade']), v.texto(a.valor, 'o alvo', 80));
        }
      }
    });
    registrar(db, req, 'circuito_alterado', { id });
    res.json(db.prepare('SELECT * FROM circuitos WHERE id = ?').get(id));
  });

  r.delete('/circuitos/:id', permitir('master', 'administrador'), (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM circuitos WHERE id = ?').get(id)) throw naoEncontrado('Circuito');
    db.prepare('UPDATE campanhas SET circuito_id = NULL WHERE circuito_id = ?').run(id);
    db.prepare('DELETE FROM circuitos WHERE id = ?').run(id);
    registrar(db, req, 'circuito_excluido', { id });
    res.status(204).end();
  });

  /** Inventário (mídia kit): o que a rede tem para vender, ponto a ponto. */
  r.get('/inventario', (req, res) => {
    const c = cfg();
    const pontos = db.prepare(`SELECT l.*, COUNT(t.id) AS telas,
        SUM(t.orientacao = 'retrato') AS retrato, SUM(t.orientacao = 'paisagem') AS paisagem,
        GROUP_CONCAT(DISTINCT t.posicao) AS posicoes
      FROM locais l LEFT JOIN telas t ON t.local_id = l.id AND t.status = 'ativa'
      WHERE l.status = 'ativo'${empresas.filtro(req, 'l.empresa_id')[0]} GROUP BY l.id ORDER BY l.cidade, l.nome`).all(...empresas.filtro(req, 'l.empresa_id')[1]);
    const itens = pontos.map((p) => ({
      ...p,
      posicoes: p.posicoes ? p.posicoes.split(',').filter(Boolean) : [],
      publico_mes: (p.publico_dia ?? 0) * 30,
      tabela_centavos: (p.telas ?? 0) * c.mensalidade_tela_centavos,
    }));
    if (req.query.csv) {
      return rel.enviarCsv(res, 'inventario.csv', rel.csv([
        ['nome', 'Ponto'], ['categoria', 'Ambiente'], ['cidade', 'Cidade'], ['uf', 'UF'], ['bairro', 'Bairro'],
        ['unidades', 'Unidades'], ['telas', 'Telas'], ['paisagem', 'Paisagem'], ['retrato', 'Retrato'],
        [(x) => x.posicoes.join(' / '), 'Posições'], ['publico_dia', 'Público/dia'], ['publico_mes', 'Público/mês'],
        [(x) => rel.reais(x.tabela_centavos), 'Tabela (R$/mês)'],
      ], itens));
    }
    res.json({
      itens,
      totais: {
        pontos: itens.length,
        telas: itens.reduce((t, x) => t + (x.telas ?? 0), 0),
        publico_dia: itens.reduce((t, x) => t + (x.publico_dia ?? 0), 0),
        cidades: new Set(itens.map((x) => x.cidade)).size,
        unidades: itens.reduce((t, x) => t + (x.unidades ?? 0), 0),
      },
      circuitos: db.prepare(`SELECT * FROM circuitos WHERE ativo = 1${empresas.filtro(req, 'empresa_id')[0]} ORDER BY nome`).all(...empresas.filtro(req, 'empresa_id')[1]).map((x) => ({ ...resumoCircuito(x), lista: undefined })),
      mensalidade_tela_centavos: c.mensalidade_tela_centavos,
      cpm_centavos: c.cpm_centavos,
    });
  });

  // ----------------------------------------------------------------- Usuários, configurações e histórico
  // ----------------------------------------------------------------- Empresas (só o master)
  r.get('/empresas', permitir('master'), (_req, res) => {
    res.json({
      itens: db.prepare(`SELECT e.*,
          (SELECT COUNT(*) FROM locais l WHERE l.empresa_id = e.id) AS pontos,
          (SELECT COUNT(*) FROM telas t JOIN locais l ON l.id = t.local_id WHERE l.empresa_id = e.id) AS telas,
          (SELECT COUNT(*) FROM anunciantes a WHERE a.empresa_id = e.id) AS anunciantes,
          (SELECT COUNT(*) FROM usuarios u WHERE u.empresa_id = e.id) AS usuarios
        FROM empresas e ORDER BY e.nome`).all(),
    });
  });

  r.post('/empresas', permitir('master'), (req, res) => {
    const nome = v.texto(req.body.nome, 'o nome da empresa', 120);
    const documento = req.body.documento ? v.documento(req.body.documento) : null;
    const id = Number(db.prepare('INSERT INTO empresas (nome, documento, criado_em) VALUES (?, ?, ?)').run(nome, documento, agora()).lastInsertRowid);
    registrar(db, req, 'empresa_criada', { id, nome });
    res.status(201).json(db.prepare('SELECT * FROM empresas WHERE id = ?').get(id));
  });

  r.patch('/empresas/:id', permitir('master'), (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM empresas WHERE id = ?').get(id)) throw naoEncontrado('Empresa');
    const d = {};
    if (req.body.nome !== undefined) d.nome = v.texto(req.body.nome, 'o nome da empresa', 120);
    if (req.body.documento !== undefined) d.documento = req.body.documento ? v.documento(req.body.documento) : null;
    if (req.body.ativo !== undefined) d.ativo = v.booleano(req.body.ativo) ? 1 : 0;
    // Perdeu o celular: a equipe desliga a verificação em duas etapas da pessoa (ligar, só ela mesma).
    if (req.body.duas_etapas === false) { d.totp_ativo = 0; d.totp_segredo = null; d.totp_reserva = null; }
    if (!Object.keys(d).length) throw new ErroNegocio('Nada para alterar.', 422);
    if (d.ativo === 0 && !db.prepare('SELECT 1 FROM empresas WHERE ativo = 1 AND id <> ?').get(id)) {
      throw new ErroNegocio('Precisa existir pelo menos uma empresa ativa.', 409);
    }
    db.prepare(`UPDATE empresas SET ${Object.keys(d).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(d), id);
    registrar(db, req, 'empresa_alterada', { id, campos: Object.keys(d) });
    res.json(db.prepare('SELECT * FROM empresas WHERE id = ?').get(id));
  });

  r.get('/usuarios', permitir('master', 'administrador'), (req, res) => {
    // Cada empresa vê a própria equipe e os acessos de portal dos seus anunciantes e pontos; o master vê todos.
    const [onde, p] = empresas.filtro(req, 'COALESCE(u.empresa_id, a.empresa_id, l.empresa_id)');
    res.json({
      itens: db.prepare(`SELECT u.id, u.nome, u.email, u.perfil, u.ativo, u.ultimo_acesso, u.criado_em, u.empresa_id, u.totp_ativo AS duas_etapas,
          a.nome AS anunciante, l.nome AS ponto, e.nome AS empresa
        FROM usuarios u LEFT JOIN anunciantes a ON a.id = u.anunciante_id LEFT JOIN locais l ON l.id = u.local_id
        LEFT JOIN empresas e ON e.id = COALESCE(u.empresa_id, a.empresa_id, l.empresa_id)
        WHERE 1 = 1${onde} ORDER BY u.perfil, u.nome`).all(...p),
    });
  });

  r.post('/usuarios', permitir('master', 'administrador'), (req, res) => {
    const perfil = v.opcao(req.body.perfil, 'o perfil', ['master', 'administrador', 'operador', 'anunciante', 'lojista']);
    // O administrador cuida da equipe, mas não cria master (senão conseguiria se promover).
    if (perfil === 'master' && req.usuario.perfil !== 'master') throw new ErroNegocio('Só o master cria outro master.', 403);
    const d = { nome: v.texto(req.body.nome, 'o nome', 120), email: v.email(req.body.email), senha_hash: hashSenha(v.senha(req.body.senha)), perfil };
    if (perfil === 'anunciante') {
      d.anunciante_id = Number(req.body.anunciante_id);
      if (!db.prepare('SELECT 1 FROM anunciantes WHERE id = ?').get(d.anunciante_id)) throw new ErroNegocio('Informe o anunciante deste acesso.', 422);
    }
    if (perfil === 'lojista') {
      d.local_id = Number(req.body.local_id);
      if (!db.prepare('SELECT 1 FROM locais WHERE id = ?').get(d.local_id)) throw new ErroNegocio('Informe o ponto deste acesso.', 422);
    }
    // Equipe de empresa (administrador, operador) fica presa à empresa: a do criador, ou a que o master escolher.
    if (['administrador', 'operador'].includes(perfil)) d.empresa_id = empresas.empresaParaGravar(db, req, req.body.empresa_id);
    const id = Number(db.prepare(`INSERT INTO usuarios (${Object.keys(d).join(', ')}, criado_em) VALUES (${Object.keys(d).map(() => '?').join(', ')}, ?)`)
      .run(...Object.values(d), agora()).lastInsertRowid);
    registrar(db, req, 'usuario_criado', { id, perfil, email: d.email, empresa_id: d.empresa_id ?? null });
    res.status(201).json({ id, nome: d.nome, email: d.email, perfil });
  });

  r.patch('/usuarios/:id', permitir('master', 'administrador'), (req, res) => {
    const id = Number(req.params.id);
    const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
    if (!u) throw naoEncontrado('Usuário');
    if (u.perfil === 'master' && req.usuario.perfil !== 'master') throw new ErroNegocio('Só o master altera um master.', 403);
    const d = {};
    if (req.body.nome !== undefined) d.nome = v.texto(req.body.nome, 'o nome', 120);
    if (req.body.email !== undefined) d.email = v.email(req.body.email);
    if (req.body.senha !== undefined) { d.senha_hash = hashSenha(v.senha(req.body.senha)); d.falhas = 0; d.bloqueado_ate = null; if (id !== req.usuario.id) d.sessao_versao = u.sessao_versao + 1; }
    if (req.body.ativo !== undefined) d.ativo = v.booleano(req.body.ativo) ? 1 : 0;
    if (req.body.perfil !== undefined && ['master', 'administrador', 'operador'].includes(u.perfil)) {
      d.perfil = v.opcao(req.body.perfil, 'o perfil', ['master', 'administrador', 'operador']);
      if (d.perfil === 'master' && req.usuario.perfil !== 'master') throw new ErroNegocio('Só o master promove alguém a master.', 403);
    }
    // Empresa: o master pode trocar a de alguém da equipe. Virou master, fica sem empresa; deixou de ser, ganha uma.
    const perfilFinal = d.perfil ?? u.perfil;
    if (perfilFinal === 'master') {
      if (u.empresa_id !== null) d.empresa_id = null;
    } else if (['administrador', 'operador'].includes(perfilFinal)
      && (u.empresa_id === null || (req.body.empresa_id !== undefined && req.usuario.perfil === 'master'))) {
      d.empresa_id = empresas.empresaParaGravar(db, req, req.body.empresa_id);
    }
    if (!Object.keys(d).length) throw new ErroNegocio('Nada para alterar.', 422);
    // Sempre precisa sobrar um master ativo.
    if ((d.ativo === 0 || (d.perfil && d.perfil !== 'master')) && u.perfil === 'master') {
      const outros = db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE perfil = 'master' AND ativo = 1 AND id <> ?").get(id).n;
      if (!outros) throw new ErroNegocio('Precisa existir pelo menos um master ativo.', 409);
    }
    db.prepare(`UPDATE usuarios SET ${Object.keys(d).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(d), id);
    registrar(db, req, 'usuario_alterado', { id, campos: Object.keys(d) });
    res.json(db.prepare('SELECT id, nome, email, perfil, ativo, empresa_id FROM usuarios WHERE id = ?').get(id));
  });

  // ----------------------------------------------------------------- Backup
  /**
   * Endereços de e-mail da empresa. Criar um endereço aqui não cria senha nem caixa em outro lugar: o
   * que chega para ele entra na caixa do CRM, e ele pode ser ligado a uma pessoa da equipe.
   */
  const dominiosEmail = () => require('../config').entrada.dominios;
  const lerEndereco = (req, atual) => {
    const d = {};
    if (!atual) {
      const local = String(req.body.local ?? '').trim().toLowerCase();
      const dominio = String(req.body.dominio ?? dominiosEmail()[0] ?? '').trim().toLowerCase();
      if (!dominiosEmail().length) throw new ErroNegocio('O servidor de e-mail ainda não tem domínio configurado (MIDIA_EMAIL_DOMINIOS).', 409);
      if (!/^[a-z0-9](?:[a-z0-9._-]{0,38}[a-z0-9])?$/.test(local)) throw new ErroNegocio('Use só letras, números, ponto, hífen e sublinhado antes do @.', 422);
      if (!dominiosEmail().includes(dominio)) throw new ErroNegocio('Domínio não atendido por este servidor.', 422);
      d.endereco = `${local}@${dominio}`;
      if (db.prepare('SELECT 1 FROM enderecos_email WHERE endereco = ?').get(d.endereco)) throw new ErroNegocio('Este endereço já existe.', 409);
    }
    if (req.body.nome !== undefined) d.nome = v.opcional(req.body.nome, 'o nome', 120);
    if (req.body.assinatura !== undefined) d.assinatura = String(req.body.assinatura ?? '').replace(/\r/g, '').trim().slice(0, 1000) || null;
    if (req.body.ativo !== undefined) d.ativo = v.booleano(req.body.ativo) ? 1 : 0;
    if (req.body.usuario_id !== undefined) {
      const uid = req.body.usuario_id ? Number(req.body.usuario_id) : null;
      if (uid) {
        const u = db.prepare('SELECT id, perfil, empresa_id FROM usuarios WHERE id = ? AND ativo = 1').get(uid);
        if (!u || !EQUIPE.includes(u.perfil)) throw new ErroNegocio('Escolha uma pessoa ativa da equipe.', 422);
        const minha = empresas.empresaDe(req);
        if (minha != null && u.empresa_id !== minha) throw new ErroNegocio('Esta pessoa não é da sua empresa.', 403);
      }
      d.usuario_id = uid;
    }
    return d;
  };
  const umEndereco = (id) => db.prepare(`SELECT en.*, u.nome AS usuario FROM enderecos_email en LEFT JOIN usuarios u ON u.id = en.usuario_id WHERE en.id = ?`).get(id);

  r.get('/enderecos-email', permitir('master', 'administrador'), (req, res) => {
    const [onde, p] = empresas.filtro(req, 'en.empresa_id');
    res.json({
      dominios: dominiosEmail(),
      itens: db.prepare(`SELECT en.*, u.nome AS usuario, e.nome AS empresa,
          (SELECT COUNT(*) FROM emails m WHERE m.endereco_id = en.id AND m.direcao = 'entrada') AS recebidos
        FROM enderecos_email en LEFT JOIN usuarios u ON u.id = en.usuario_id LEFT JOIN empresas e ON e.id = en.empresa_id
        WHERE 1 = 1${onde} ORDER BY en.endereco`).all(...p),
    });
  });

  r.post('/enderecos-email', permitir('master', 'administrador'), (req, res) => {
    const d = lerEndereco(req, null);
    // A empresa do endereço é a da pessoa ligada a ele; sem pessoa, a de quem está criando.
    const doUsuario = d.usuario_id ? db.prepare('SELECT empresa_id FROM usuarios WHERE id = ?').get(d.usuario_id)?.empresa_id : null;
    const id = Number(db.prepare('INSERT INTO enderecos_email (empresa_id, endereco, nome, assinatura, usuario_id, criado_em) VALUES (?, ?, ?, ?, ?, ?)')
      .run(doUsuario ?? empresas.empresaParaGravar(db, req, req.body.empresa_id), d.endereco, d.nome ?? null, d.assinatura ?? null, d.usuario_id ?? null, agora()).lastInsertRowid);
    registrar(db, req, 'endereco_email_criado', { id, endereco: d.endereco });
    res.status(201).json(umEndereco(id));
  });

  r.patch('/enderecos-email/:id', permitir('master', 'administrador'), (req, res) => {
    const id = Number(req.params.id);
    const atual = db.prepare('SELECT * FROM enderecos_email WHERE id = ?').get(id);
    if (!atual) throw naoEncontrado('Endereço');
    const d = lerEndereco(req, atual);
    if (Object.keys(d).length) db.prepare(`UPDATE enderecos_email SET ${Object.keys(d).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(d), id);
    registrar(db, req, 'endereco_email_alterado', { id, campos: Object.keys(d) });
    res.json(umEndereco(id));
  });

  r.delete('/enderecos-email/:id', permitir('master', 'administrador'), (req, res) => {
    const id = Number(req.params.id);
    const atual = db.prepare('SELECT * FROM enderecos_email WHERE id = ?').get(id);
    if (!atual) throw naoEncontrado('Endereço');
    // As mensagens ficam (voltam para a caixa geral); só o endereço sai.
    db.prepare('UPDATE emails SET endereco_id = NULL WHERE endereco_id = ?').run(id);
    db.prepare('DELETE FROM enderecos_email WHERE id = ?').run(id);
    registrar(db, req, 'endereco_email_excluido', { id, endereco: atual.endereco });
    res.status(204).end();
  });

  r.get('/backups', permitir('master'), (_req, res) => {
    res.json({ ...backup.situacao(), itens: backup.listar(), arquivos_bytes: require('../lib/arquivos').tamanhoNoDisco() });
  });

  r.post('/backups', permitir('master'), (req, res) => {
    const b = backup.gerar(db);
    const espelho = backup.espelhar();
    registrar(db, req, 'backup_gerado', { nome: b.nome, tamanho: b.tamanho, espelhados: espelho.copiados });
    res.status(201).json({ ...b, espelho });
  });

  r.get('/backups/:nome', permitir('master'), (req, res) => {
    const caminho = backup.caminho(req.params.nome);
    if (!caminho) throw naoEncontrado('Backup');
    registrar(db, req, 'backup_baixado', { nome: req.params.nome });
    res.download(caminho);
  });

  r.get('/configuracoes', permitir('master', 'administrador'), (_req, res) => res.json({
    ...cfg(),
    padroes: CONFIG_PADRAO,
    email: { configurado: emailLib.configurado(), equipe: avisos.equipe(db).length, url: require('../config').url || null },
  }));

  /** Teste de envio: confirma que o SMTP está falando com o mundo antes de depender dele. */
  r.post('/configuracoes/email-teste', permitir('master', 'administrador'), async (req, res) => {
    const para = req.body.para ? v.email(req.body.para) : req.usuario.email;
    const r2 = await emailLib.enviar({
      para,
      assunto: 'Teste de envio',
      plataforma: cfg().nome_plataforma,
      titulo: 'Deu certo',
      linhas: ['Se esta mensagem chegou, os avisos automáticos da plataforma conseguem sair deste servidor.'],
      botao: { texto: 'Abrir o painel', url: emailLib.linkPainel('') },
    }, { exigir: true });
    registrar(db, req, 'email_teste', { para, enviado: r2.enviado });
    res.json(r2);
  });

  // Atualizar o sistema pelo painel: só o master, e com a senha digitada de novo.
  r.get('/sistema/atualizacao', permitir('master'), (_req, res) => res.json(atualizacao.situacao()));

  // Comandos do servidor: só o master, só os da lista e com a senha digitada de novo.
  r.get('/sistema/comandos', permitir('master'), (_req, res) => res.json(require('../lib/comandos').situacao()));
  r.post('/sistema/comandos', permitir('master'), (req, res) => {
    const u = db.prepare('SELECT senha_hash FROM usuarios WHERE id = ?').get(req.usuario.id);
    if (!u || !verificarSenha(String(req.body.senha ?? ''), u.senha_hash)) {
      registrar(db, req, 'comando_senha_errada', {});
      throw new ErroNegocio('Senha incorreta. O comando não foi rodado.', 403);
    }
    const item = require('../lib/comandos').pedir(String(req.body.id ?? ''), req.usuario);
    registrar(db, req, 'comando_pedido', { id: item.id });
    res.status(202).json({ ok: true, comando: item });
  });

  // O registro DKIM para colar no Registro.br (só a chave pública).
  r.get('/sistema/dkim', permitir('master'), (_req, res) => res.json(require('../lib/email').registroDkim()));

  r.post('/sistema/atualizacao', permitir('master'), (req, res) => {
    let senha = '';
    // A senha vem num cabeçalho (o corpo é o próprio .zip), codificada para aceitar acento.
    try { senha = decodeURIComponent(String(req.get('X-Confirmar-Senha') ?? '')); } catch { /* fica vazia */ }
    const u = db.prepare('SELECT senha_hash FROM usuarios WHERE id = ?').get(req.usuario.id);
    if (!u || !verificarSenha(senha, u.senha_hash)) {
      registrar(db, req, 'atualizacao_senha_errada', {});
      throw new ErroNegocio('Senha incorreta. A atualização não foi feita.', 403);
    }
    const pedido = atualizacao.pedir(req.body, req.usuario);
    registrar(db, req, 'atualizacao_pedida', { bytes: pedido.bytes });
    // Todo master fica sabendo: se não foi alguém da casa, dá tempo de agir.
    const masters = db.prepare("SELECT email FROM usuarios WHERE perfil = 'master' AND ativo = 1").all().map((m) => m.email);
    require('../lib/email').enviar({
      para: masters, assunto: 'O sistema está sendo atualizado', plataforma: lerConfig(db).nome_plataforma, titulo: 'Atualização do sistema pedida',
      linhas: [`${req.usuario.nome} (${req.usuario.email}) enviou uma atualização do sistema pelo painel.`,
        'Se não foi alguém da equipe, troque as senhas dos usuários master agora.'],
    }).catch(() => {});
    res.status(202).json({ ok: true, pedido });
  });

  r.put('/configuracoes', permitir('master'), (req, res) => {
    const limites = {
      duracao_imagem_s: [3, 120], insercoes_hora_padrao: [1, 120], bloco_minimo_s: [30, 3600], bloco_maximo_s: [60, 7200],
      batida_intervalo_s: [15, 900], offline_minutos: [2, 1440], mensalidade_tela_centavos: [0, 1_000_000_00], cpm_centavos: [0, 1_000_000],
      comissao_local_percentual: [0, 10_000], vencimento_dia: [1, 28], aviso_lojista: [0, 1], comunicado_automatico: [0, 1], marca_preenche: [0, 1], marca_duracao_s: [5, 60], avisos_email: [0, 1], prova_dias: [0, 3650],
      foto_minutos: [0, 1440], contrato_aviso_dias: [0, 180], clima_ligado: [0, 1],
    };
    transacao(db, () => {
      for (const [k] of Object.entries(CONFIG_PADRAO)) {
        if (req.body[k] === undefined) continue;
        if (TEXTO.has(k)) {
          const limiteTexto = { nome_plataforma: 60, slogan: 80 }[k] ?? 80;
          gravarConfig(db, k, k === 'nome_plataforma'
            ? v.texto(req.body[k], 'o nome da plataforma', limiteTexto)
            : (v.opcional(req.body[k], k, limiteTexto) ?? ''));
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
    const [fe, fp] = empresas.filtro(req, 'COALESCE(u.empresa_id, ua.empresa_id, ul.empresa_id)');
    if (fe) { onde.push(fe.replace(' AND ', '')); p.push(...fp); }
    const limite = Math.min(500, Number(req.query.limite) || 100);
    res.json({
      itens: db.prepare(`SELECT a.*, u.nome AS usuario FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id
        LEFT JOIN anunciantes ua ON ua.id = u.anunciante_id LEFT JOIN locais ul ON ul.id = u.local_id
        ${onde.length ? `WHERE ${onde.join(' AND ')}` : ''} ORDER BY a.id DESC LIMIT ?`).all(...p, limite),
    });
  });

  /** Lista enxuta para preencher seletores (anunciantes, pontos e telas). */
  r.get('/opcoes', (req, res) => {
    const c = cfg();
    // Só o que é da empresa de quem está usando (o master vê tudo e também escolhe a empresa).
    const f = (col) => empresas.filtro(req, col);
    const [fa, pa] = f('empresa_id');
    const [fl, pl] = f('l.empresa_id');
    const master = empresas.empresaDe(req) === null;
    res.json({
      anunciantes: db.prepare(`SELECT id, nome FROM anunciantes WHERE status = 'ativo'${fa} ORDER BY nome`).all(...pa),
      agencias: db.prepare(`SELECT id, nome, comissao_percentual FROM agencias WHERE status = 'ativa'${fa} ORDER BY nome`).all(...pa),
      circuitos: db.prepare(`SELECT id, nome, insercoes_hora, valor_mes_centavos, cpm_centavos FROM circuitos WHERE ativo = 1${fa} ORDER BY nome`).all(...pa),
      locais: db.prepare(`SELECT id, nome, cidade, categoria FROM locais WHERE status <> 'encerrado'${fa} ORDER BY nome`).all(...pa),
      telas: db.prepare(`SELECT t.id, t.nome, t.orientacao, t.local_id, l.nome AS local_nome, t.ultimo_contato FROM telas t JOIN locais l ON l.id = t.local_id
        WHERE t.status <> 'inativa'${fl} ORDER BY l.nome, t.nome`).all(...pl).map((t) => ({ ...t, online: estaOnline(t, c) })),
      cidades: db.prepare(`SELECT DISTINCT cidade FROM locais WHERE cidade <> ''${fa} ORDER BY cidade`).all(...pa).map((x) => x.cidade),
      // Quem pode ser responsável por um lead no CRM: a equipe da empresa (e os masters).
      equipe: db.prepare(`SELECT id, nome FROM usuarios WHERE perfil IN ('master','administrador','operador') AND ativo = 1
        ${master ? '' : 'AND (empresa_id = ? OR perfil = \'master\')'} ORDER BY nome`).all(...(master ? [] : [empresas.empresaDe(req)])),
      empresas: master ? db.prepare('SELECT id, nome, ativo FROM empresas ORDER BY nome').all() : [],
      competencias: db.prepare('SELECT DISTINCT substr(data, 1, 7) AS competencia FROM resumo_dia ORDER BY competencia DESC LIMIT 24').all().map((x) => x.competencia),
    });
  });

  return r;
};
