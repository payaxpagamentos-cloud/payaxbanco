'use strict';

const { Router } = require('express');
const QRCode = require('qrcode');
const { agora, transacao, lerConfig, gravarConfig, CONFIG_PADRAO, TEXTO } = require('../db');
const { permitir } = require('../auth');
const { ErroNegocio, naoEncontrado } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { hashSenha } = require('../lib/senha');
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

  // ----------------------------------------------------------------- Fechamento do mês
  // (as faturas, os repasses, os contratos e as despesas ficam em routes/financeiro.js)
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

  // ----------------------------------------------------------------- Agências
  r.get('/agencias', (_req, res) => {
    res.json({
      itens: db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM campanhas c WHERE c.agencia_id = a.id) AS campanhas,
          (SELECT COUNT(*) FROM campanhas c WHERE c.agencia_id = a.id AND c.status = 'ativa') AS campanhas_ativas
        FROM agencias a ORDER BY a.nome`).all(),
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

  r.get('/circuitos', (_req, res) => {
    res.json({ itens: db.prepare('SELECT * FROM circuitos ORDER BY ativo DESC, nome').all().map((c) => ({ ...resumoCircuito(c), lista: undefined })) });
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

  r.delete('/circuitos/:id', permitir('master'), (req, res) => {
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
      WHERE l.status = 'ativo' GROUP BY l.id ORDER BY l.cidade, l.nome`).all();
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
      circuitos: db.prepare('SELECT * FROM circuitos WHERE ativo = 1 ORDER BY nome').all().map((x) => ({ ...resumoCircuito(x), lista: undefined })),
      mensalidade_tela_centavos: c.mensalidade_tela_centavos,
      cpm_centavos: c.cpm_centavos,
    });
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

  // ----------------------------------------------------------------- Backup
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

  r.get('/configuracoes', permitir('master'), (_req, res) => res.json({
    ...cfg(),
    padroes: CONFIG_PADRAO,
    email: { configurado: emailLib.configurado(), equipe: avisos.equipe(db).length, url: require('../config').url || null },
  }));

  /** Teste de envio: confirma que o SMTP está falando com o mundo antes de depender dele. */
  r.post('/configuracoes/email-teste', permitir('master'), async (req, res) => {
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
      agencias: db.prepare("SELECT id, nome, comissao_percentual FROM agencias WHERE status = 'ativa' ORDER BY nome").all(),
      circuitos: db.prepare('SELECT id, nome, insercoes_hora, valor_mes_centavos, cpm_centavos FROM circuitos WHERE ativo = 1 ORDER BY nome').all(),
      locais: db.prepare("SELECT id, nome, cidade, categoria FROM locais WHERE status <> 'encerrado' ORDER BY nome").all(),
      telas: db.prepare(`SELECT t.id, t.nome, t.orientacao, t.local_id, l.nome AS local_nome, t.ultimo_contato FROM telas t JOIN locais l ON l.id = t.local_id
        WHERE t.status <> 'inativa' ORDER BY l.nome, t.nome`).all().map((t) => ({ ...t, online: estaOnline(t, c) })),
      cidades: db.prepare("SELECT DISTINCT cidade FROM locais WHERE cidade <> '' ORDER BY cidade").all().map((x) => x.cidade),
      // Quem pode ser responsável por um lead no CRM.
      equipe: db.prepare("SELECT id, nome FROM usuarios WHERE perfil IN ('master','operador') AND ativo = 1 ORDER BY nome").all(),
      competencias: db.prepare('SELECT DISTINCT substr(data, 1, 7) AS competencia FROM resumo_dia ORDER BY competencia DESC LIMIT 24').all().map((x) => x.competencia),
    });
  });

  return r;
};
