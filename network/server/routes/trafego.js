'use strict';

const { Router } = require('express');
const { agora } = require('../db');
const { exigir } = require('../auth');
const { pode } = require('../lib/permissoes');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { listaPaginada, like, csv } = require('../lib/http');
const { lerIp, textoDe } = require('../lib/ip');
const { cifrar } = require('../lib/cripto');
const radius = require('../lib/radius');
const { estadoFonte } = require('./ddos');
const v = require('../lib/validacao');

const PAPEIS = ['borda', 'bras', 'core'];

module.exports = (db) => {
  const r = Router();
  const periodo = (q, padrao = 24, max = 24 * 31) => v.inteiro(q.horas ?? padrao, 'o período', { min: 1, max });

  /**
   * Série do tráfego (bits/s médio por intervalo) de entrada e saída dos grupos protegidos.
   * Até 6 h: ponto por minuto; até 2 dias: 5 min; acima: 1 h.
   */
  r.get('/resumo', exigir('trafego.ver'), (req, res) => {
    const horas = periodo(req.query);
    const passo = horas <= 6 ? 1 : horas <= 48 ? 5 : 60;
    const desde = new Date(Date.now() - horas * 3600_000).toISOString().slice(0, 16);
    const grupoId = req.query.grupo_id ? Number(req.query.grupo_id) : null;
    const filtroGrupo = grupoId ? 'AND grupo_id = ?' : '';
    const p = grupoId ? [req.org, desde, grupoId] : [req.org, desde];
    // Arredonda o minuto para o passo: 'AAAA-MM-DDTHH:MM' → minutos desde a época / passo.
    const linhas = db.prepare(`SELECT CAST(strftime('%s', minuto || ':00') / 60 / ${passo} AS INTEGER) * ${passo} AS bloco, direcao, SUM(bytes) AS bytes, SUM(pacotes) AS pacotes,
      SUM(bytes_tcp) AS tcp, SUM(bytes_udp) AS udp, COUNT(DISTINCT minuto) AS minutos FROM trafego_minuto WHERE organizacao_id = ? AND minuto >= ? ${filtroGrupo}
      GROUP BY bloco, direcao ORDER BY bloco`).all(...p);
    const serie = new Map();
    for (const l of linhas) {
      const em = new Date(l.bloco * 60_000).toISOString();
      if (!serie.has(em)) serie.set(em, { em, entrada_bps: 0, saida_bps: 0, entrada_pps: 0, saida_pps: 0 });
      const x = serie.get(em);
      const seg = passo * 60;
      x[`${l.direcao}_bps`] = (l.bytes * 8) / seg;
      x[`${l.direcao}_pps`] = l.pacotes / seg;
    }
    // O intervalo em andamento fica de fora: com poucos minutos somados, ele pareceria uma queda de tráfego.
    const limite = Math.floor(Date.now() / 60_000) * 60_000 - 60_000;
    const pontos = [...serie.values()].filter((x) => Date.parse(x.em) + passo * 60_000 <= limite + 60_000);
    const pico = (k) => pontos.reduce((m, x) => (x[k] > m.valor ? { valor: x[k], em: x.em } : m), { valor: 0, em: null });
    const grupos = db.prepare(`SELECT g.id, g.nome, t.direcao, SUM(t.bytes) AS bytes FROM trafego_minuto t JOIN grupos_ip g ON g.id = t.grupo_id
      WHERE t.organizacao_id = ? AND t.minuto >= ? GROUP BY g.id, t.direcao ORDER BY bytes DESC`).all(req.org, desde);
    const totais = db.prepare(`SELECT direcao, SUM(bytes) AS bytes, SUM(bytes_tcp) AS tcp, SUM(bytes_udp) AS udp FROM trafego_minuto WHERE organizacao_id = ? AND minuto >= ? ${filtroGrupo}
      GROUP BY direcao`).all(...p);
    res.json({ horas, passo_min: passo, serie: pontos, pico_entrada: pico('entrada_bps'), pico_saida: pico('saida_bps'), atual: pontos.at(-1) ?? null,
      totais: Object.fromEntries(totais.map((t) => [t.direcao, t])), grupos, gerado_em: agora() });
  });

  /** IPs que mais trafegaram no período (soma por hora). */
  r.get('/top', exigir('trafego.ver'), (req, res) => {
    const horas = periodo(req.query, 1, 24 * 31);
    const direcao = v.opcao(req.query.direcao ?? 'entrada', 'a direção', ['entrada', 'saida']);
    const desde = `${new Date(Date.now() - horas * 3600_000).toISOString().slice(0, 13)}:00`;
    const itens = db.prepare(`SELECT t.ip, t.grupo_id, g.nome AS grupo_nome, SUM(t.bytes) AS bytes, SUM(t.pacotes) AS pacotes, SUM(t.fluxos) AS fluxos
      FROM trafego_ip_hora t LEFT JOIN grupos_ip g ON g.id = t.grupo_id WHERE t.organizacao_id = ? AND t.direcao = ? AND t.hora >= ?
      GROUP BY t.ip ORDER BY bytes DESC LIMIT ?`).all(req.org, direcao, desde, v.inteiro(req.query.limite ?? 20, 'o limite', { min: 1, max: 200 }));
    const verLogin = pode(req.usuario.perfil, 'assinantes.ver');
    const resultado = itens.map((x) => ({ ...x, login: verLogin ? radius.loginNoInstante(db, req.org, x.ip)?.login ?? null : undefined }));
    if (req.query.formato === 'csv') {
      res.type('text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="top-${direcao}.csv"`);
      return res.send(csv([['IP', 'Grupo', verLogin ? 'Login' : null, 'Bytes', 'Pacotes', 'Fluxos'].filter((c) => c !== null),
        ...resultado.map((x) => [x.ip, x.grupo_nome ?? '', ...(verLogin ? [x.login ?? ''] : []), Math.round(x.bytes), Math.round(x.pacotes), Math.round(x.fluxos)])]));
    }
    res.json({ horas, direcao, itens: resultado });
  });

  /** Ficha de um IP: tráfego por hora (7 dias), ataques e, para quem pode, as sessões (login) que usaram o IP. */
  r.get('/ip/:ip', exigir('trafego.ver'), (req, res) => {
    const ip = lerIp(req.params.ip);
    if (!ip) throw new ErroNegocio('IP inválido.', 422);
    const texto = textoDe(ip);
    const desde = `${new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 13)}:00`;
    const verLogin = pode(req.usuario.perfil, 'assinantes.ver');
    res.json({
      ip: texto,
      versao: ip.v,
      serie: db.prepare(`SELECT hora, direcao, bytes, pacotes FROM trafego_ip_hora WHERE organizacao_id = ? AND ip = ? AND hora >= ? ORDER BY hora`).all(req.org, texto, desde),
      ataques: db.prepare('SELECT id, numero, direcao, vetor, severidade, status, inicio, fim, pico_bps FROM ataques WHERE organizacao_id = ? AND alvo = ? ORDER BY inicio DESC LIMIT 20')
        .all(req.org, texto),
      sessoes: verLogin ? db.prepare(`SELECT login, nas_ip, mac, inicio, fim, motivo_fim, bytes_entrada, bytes_saida FROM sessoes_assinantes WHERE organizacao_id = ? AND ip = ?
        ORDER BY inicio DESC LIMIT 30`).all(req.org, texto) : null,
      grupo: db.prepare('SELECT t.grupo_id, g.nome FROM trafego_ip_hora t LEFT JOIN grupos_ip g ON g.id = t.grupo_id WHERE t.organizacao_id = ? AND t.ip = ? ORDER BY t.hora DESC LIMIT 1')
        .get(req.org, texto) ?? null,
    });
  });

  // ---------------------------------------------------------------- Sessões dos assinantes
  r.get('/sessoes', exigir('assinantes.ver'), (req, res) => {
    const f = ['organizacao_id = ?'];
    const p = [req.org];
    const busca = String(req.query.busca ?? '').trim();
    if (busca) {
      if (lerIp(busca)) { f.push('ip = ?'); p.push(textoDe(lerIp(busca))); }
      else { f.push("(login LIKE ? ESCAPE '\\' OR mac LIKE ? ESCAPE '\\')"); p.push(like(busca), like(busca)); }
    }
    if (req.query.ativas === '1') f.push('fim IS NULL');
    if (req.query.instante) {
      const t = v.instante(req.query.instante, 'o instante');
      f.push('inicio <= ? AND (fim IS NULL OR fim >= ?)');
      p.push(t, t);
    }
    res.json(listaPaginada(db, `SELECT * FROM sessoes_assinantes WHERE ${f.join(' AND ')} ORDER BY inicio DESC`, p, req.query));
  });

  r.get('/sessoes/resumo', exigir('assinantes.ver'), (req, res) => {
    res.json({
      ativas: db.prepare('SELECT COUNT(*) AS n FROM sessoes_assinantes WHERE organizacao_id = ? AND fim IS NULL').get(req.org).n,
      por_nas: db.prepare('SELECT nas_ip, COUNT(*) AS n FROM sessoes_assinantes WHERE organizacao_id = ? AND fim IS NULL GROUP BY nas_ip ORDER BY n DESC').all(req.org),
      com_ipv6: db.prepare('SELECT COUNT(*) AS n FROM sessoes_assinantes WHERE organizacao_id = ? AND fim IS NULL AND (ipv6_prefixo IS NOT NULL OR ipv6_delegado IS NOT NULL)').get(req.org).n,
    });
  });

  // ---------------------------------------------------------------- Fontes: exportadores de flow e NAS RADIUS
  r.get('/fontes', exigir('trafego.ver'), (req, res) => {
    res.json({
      exportadores: db.prepare('SELECT * FROM exportadores_fluxo WHERE organizacao_id = ? ORDER BY nome').all(req.org).map((e) => ({ ...e, estado: estadoFonte(e) })),
      nas: db.prepare('SELECT id, nome, ip, ativo, ultimo_pacote, pacotes, erros, ultimo_erro, criado_em FROM radius_nas WHERE organizacao_id = ? ORDER BY nome').all(req.org)
        .map((n) => ({ ...n, estado: estadoFonte(n) })),
    });
  });

  const ipObrigatorio = (x) => {
    const ip = lerIp(x);
    if (!ip) throw new ErroNegocio('Informe o IP de origem dos pacotes (o endereço que o roteador usa para exportar).', 422);
    return textoDe(ip);
  };
  const exportador = (req) => {
    const e = db.prepare('SELECT * FROM exportadores_fluxo WHERE id = ? AND organizacao_id = ?').get(Number(req.params.id), req.org);
    if (!e) throw new ErroNegocio('Exportador não encontrado.', 404);
    return e;
  };

  r.post('/exportadores', exigir('ddos.configurar'), (req, res) => {
    const b = req.body ?? {};
    const d = { nome: v.texto(b.nome, 'o nome', 80), ip: ipObrigatorio(b.ip), papel: v.opcao(b.papel ?? 'borda', 'o papel', PAPEIS),
      taxa_amostragem: v.inteiro(b.taxa_amostragem ?? 1, 'a taxa de amostragem', { min: 1, max: 1_000_000 }), observacao: v.opcional(b.observacao, 'a observação', 300) };
    if (db.prepare('SELECT 1 FROM exportadores_fluxo WHERE ip = ?').get(d.ip)) throw new ErroNegocio('Já existe um exportador com esse IP.', 409);
    const t = agora();
    const id = Number(db.prepare(`INSERT INTO exportadores_fluxo (organizacao_id, nome, ip, papel, taxa_amostragem, observacao, criado_em, atualizado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(req.org, d.nome, d.ip, d.papel, d.taxa_amostragem, d.observacao, t, t).lastInsertRowid);
    registrar(db, req, 'exportador_criado', { recurso: 'exportador', recursoId: id, depois: d });
    res.status(201).json(db.prepare('SELECT * FROM exportadores_fluxo WHERE id = ?').get(id));
  });

  r.patch('/exportadores/:id', exigir('ddos.configurar'), (req, res) => {
    const e = exportador(req);
    const b = req.body ?? {};
    const d = {
      nome: b.nome !== undefined ? v.texto(b.nome, 'o nome', 80) : e.nome,
      ip: b.ip !== undefined ? ipObrigatorio(b.ip) : e.ip,
      papel: b.papel !== undefined ? v.opcao(b.papel, 'o papel', PAPEIS) : e.papel,
      taxa_amostragem: b.taxa_amostragem !== undefined ? v.inteiro(b.taxa_amostragem, 'a taxa de amostragem', { min: 1, max: 1_000_000 }) : e.taxa_amostragem,
      ativo: b.ativo !== undefined ? (v.booleano(b.ativo) ? 1 : 0) : e.ativo,
      observacao: b.observacao !== undefined ? v.opcional(b.observacao, 'a observação', 300) : e.observacao,
    };
    db.prepare('UPDATE exportadores_fluxo SET nome = ?, ip = ?, papel = ?, taxa_amostragem = ?, ativo = ?, observacao = ?, atualizado_em = ? WHERE id = ?')
      .run(d.nome, d.ip, d.papel, d.taxa_amostragem, d.ativo, d.observacao, agora(), e.id);
    registrar(db, req, 'exportador_alterado', { recurso: 'exportador', recursoId: e.id, antes: e, depois: d });
    res.json(db.prepare('SELECT * FROM exportadores_fluxo WHERE id = ?').get(e.id));
  });

  const nasPublico = (id) => db.prepare('SELECT id, nome, ip, ativo, ultimo_pacote, pacotes, erros, ultimo_erro, criado_em FROM radius_nas WHERE id = ?').get(id);
  r.post('/nas', exigir('ddos.configurar'), (req, res) => {
    const b = req.body ?? {};
    const nome = v.texto(b.nome, 'o nome', 80);
    const ip = ipObrigatorio(b.ip);
    const segredo = v.texto(b.segredo, 'o segredo RADIUS', 200);
    if (db.prepare('SELECT 1 FROM radius_nas WHERE ip = ?').get(ip)) throw new ErroNegocio('Já existe um NAS com esse IP.', 409);
    const t = agora();
    const id = Number(db.prepare('INSERT INTO radius_nas (organizacao_id, nome, ip, segredo_cifrado, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.org, nome, ip, cifrar(segredo), t, t).lastInsertRowid);
    registrar(db, req, 'nas_criado', { recurso: 'nas', recursoId: id, depois: { nome, ip } });
    res.status(201).json(nasPublico(id));
  });

  r.patch('/nas/:id', exigir('ddos.configurar'), (req, res) => {
    const n = db.prepare('SELECT * FROM radius_nas WHERE id = ? AND organizacao_id = ?').get(Number(req.params.id), req.org);
    if (!n) throw new ErroNegocio('NAS não encontrado.', 404);
    const b = req.body ?? {};
    const d = { nome: b.nome !== undefined ? v.texto(b.nome, 'o nome', 80) : n.nome, ip: b.ip !== undefined ? ipObrigatorio(b.ip) : n.ip,
      ativo: b.ativo !== undefined ? (v.booleano(b.ativo) ? 1 : 0) : n.ativo };
    const segredo = b.segredo ? cifrar(v.texto(b.segredo, 'o segredo', 200)) : n.segredo_cifrado;
    db.prepare('UPDATE radius_nas SET nome = ?, ip = ?, ativo = ?, segredo_cifrado = ?, atualizado_em = ? WHERE id = ?').run(d.nome, d.ip, d.ativo, segredo, agora(), n.id);
    registrar(db, req, 'nas_alterado', { recurso: 'nas', recursoId: n.id, antes: { nome: n.nome, ip: n.ip, ativo: n.ativo }, depois: { ...d, segredo_alterado: Boolean(b.segredo) } });
    res.json(nasPublico(n.id));
  });

  return r;
};
