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
const conteudo = require('../lib/conteudo');
const { lerPrefixo } = require('../lib/ip');
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

  // ---------------------------------------------------------------- Consumo em tempo real
  /**
   * Painel de consumo: somas de 5 s (até 6 h). Resolução: até 15 min, 5 s; até 1 h, 10 s; até 6 h, 1 min.
   * Devolve séries de bits/s e pacotes/s por direção, protocolos (entrada), por grupo (entrada), o top de IPs agora e a capacidade.
   */
  r.get('/tempo-real', exigir('trafego.ver'), (req, res) => {
    const minutos = v.inteiro(req.query.minutos ?? 15, 'o período', { min: 5, max: 360 });
    const passo = minutos <= 15 ? 5 : minutos <= 60 ? 10 : 60;
    const agoraMs = Date.now();
    // Só blocos fechados: o bloco de 5 s em andamento (e o atraso da gravação) ficariam como queda falsa.
    const fim = Math.floor(agoraMs / 5000) * 5000 - 5000;
    const desde = new Date(fim - minutos * 60_000).toISOString();
    const ate = new Date(fim).toISOString();
    const grupoId = req.query.grupo_id ? Number(req.query.grupo_id) : null;
    const fg = grupoId ? 'AND grupo_id = ?' : '';
    const p = grupoId ? [req.org, desde, ate, grupoId] : [req.org, desde, ate];
    const bloco = `CAST(strftime('%s', substr(em, 1, 19)) / ${passo} AS INTEGER) * ${passo}`;
    const linhas = db.prepare(`SELECT ${bloco} AS b, direcao, SUM(bytes) AS bytes, SUM(pacotes) AS pacotes, SUM(fluxos) AS fluxos, SUM(bytes_tcp) AS tcp, SUM(bytes_udp) AS udp,
      SUM(bytes_icmp) AS icmp FROM trafego_tempo_real WHERE organizacao_id = ? AND em >= ? AND em < ? ${fg} GROUP BY b, direcao ORDER BY b`).all(...p);
    const pontos = new Map();
    for (const l of linhas) {
      const em = l.b * 1000;
      if (!pontos.has(em)) pontos.set(em, { em, entrada_bps: 0, saida_bps: 0, entrada_pps: 0, saida_pps: 0, entrada_fps: 0, tcp_bps: 0, udp_bps: 0, icmp_bps: 0, outros_bps: 0 });
      const x = pontos.get(em);
      x[`${l.direcao}_bps`] = (l.bytes * 8) / passo;
      x[`${l.direcao}_pps`] = l.pacotes / passo;
      if (l.direcao === 'entrada') {
        x.entrada_fps = l.fluxos / passo;
        x.tcp_bps = (l.tcp * 8) / passo;
        x.udp_bps = (l.udp * 8) / passo;
        x.icmp_bps = (l.icmp * 8) / passo;
        x.outros_bps = Math.max(0, ((l.bytes - l.tcp - l.udp - l.icmp) * 8) / passo);
      }
    }
    const grupos = db.prepare(`SELECT ${bloco} AS b, t.grupo_id, g.nome, SUM(t.bytes) AS bytes FROM trafego_tempo_real t JOIN grupos_ip g ON g.id = t.grupo_id
      WHERE t.organizacao_id = ? AND t.em >= ? AND t.em < ? AND t.direcao = 'entrada' GROUP BY b, t.grupo_id ORDER BY b`).all(req.org, desde, ate);
    const porGrupo = new Map();
    for (const l of grupos) {
      if (!porGrupo.has(l.grupo_id)) porGrupo.set(l.grupo_id, { id: l.grupo_id, nome: l.nome, pontos: [] });
      porGrupo.get(l.grupo_id).pontos.push([l.b * 1000, (l.bytes * 8) / passo]);
    }
    const verLogin = pode(req.usuario.perfil, 'assinantes.ver');
    const top = db.prepare(`SELECT t.direcao, t.posicao, t.ip, t.bps, t.pps, t.atualizado_em, g.nome AS grupo_nome FROM trafego_top_atual t LEFT JOIN grupos_ip g ON g.id = t.grupo_id
      WHERE t.organizacao_id = ? ORDER BY t.direcao, t.posicao`).all(req.org)
      .map((x) => ({ ...x, login: verLogin ? radius.loginNoInstante(db, req.org, x.ip)?.login ?? null : undefined }));
    const cfg = db.prepare('SELECT capacidade_bps FROM ddos_config WHERE organizacao_id = ?').get(req.org);
    const lista = [...pontos.values()];
    res.json({ minutos, passo_s: passo, gerado_em: agora(), ate, serie: lista, grupos: [...porGrupo.values()],
      top: { entrada: top.filter((x) => x.direcao === 'entrada'), saida: top.filter((x) => x.direcao === 'saida'), atualizado_em: top[0]?.atualizado_em ?? null },
      capacidade_bps: cfg?.capacidade_bps ?? null,
      exportadores: db.prepare("SELECT nome, papel, ultimo_pacote, ativo FROM exportadores_fluxo WHERE organizacao_id = ? AND papel = 'borda'").all(req.org)
        .map((e) => ({ ...e, estado: estadoFonte(e) })) });
  });

  // ---------------------------------------------------------------- Conteúdos
  const nomeChave = (catalogo, nomesAsn) => (ch) => {
    if (ch.startsWith('c:')) { const c = catalogo.get(Number(ch.slice(2))); return { nome: c?.nome ?? 'Conteúdo removido', categoria: c?.categoria ?? 'outros', marca: c?.marca ?? null, aviso: c?.aviso ?? null, catalogado: true }; }
    if (ch.startsWith('as:')) { const asn = Number(ch.slice(3)); return { nome: `AS${asn}${nomesAsn.get(asn) ? ` · ${nomesAsn.get(asn)}` : ''}`, categoria: null, asn, catalogado: false }; }
    return { nome: ch === 'outros' ? 'Outros (cauda longa)' : 'Sem identificação', categoria: null, catalogado: false };
  };

  /**
   * Principais conteúdos no período: ranking, série empilhada dos 8 maiores, fluxo conteúdo → grupo de clientes,
   * comparação com o período anterior e cobertura da identificação.
   */
  r.get('/conteudo', exigir('trafego.ver'), (req, res) => {
    conteudo.garantirCatalogo(db, req.org);
    const horas = periodo(req.query, 24, 24 * 90);
    const direcao = v.opcao(req.query.direcao ?? 'entrada', 'a direção', ['entrada', 'saida']);
    const porHora = horas > 48;
    const tab = porHora ? 'conteudo_hora' : 'conteudo_minuto';
    const col = porHora ? 'hora' : 'minuto';
    const fmt = (ms) => (porHora ? `${new Date(ms).toISOString().slice(0, 13)}:00` : new Date(ms).toISOString().slice(0, 16));
    const agoraMs = Date.now();
    const desde = fmt(agoraMs - horas * 3600_000);
    const antes = fmt(agoraMs - 2 * horas * 3600_000);
    const catalogo = new Map(db.prepare('SELECT * FROM conteudos WHERE organizacao_id = ?').all(req.org).map((c) => [c.id, c]));
    const ranking = db.prepare(`SELECT chave, SUM(bytes) AS bytes, SUM(pacotes) AS pacotes, SUM(fluxos) AS fluxos FROM ${tab}
      WHERE organizacao_id = ? AND direcao = ? AND ${col} >= ? GROUP BY chave ORDER BY bytes DESC`).all(req.org, direcao, desde);
    const anterior = new Map(db.prepare(`SELECT chave, SUM(bytes) AS bytes FROM ${tab} WHERE organizacao_id = ? AND direcao = ? AND ${col} >= ? AND ${col} < ? GROUP BY chave`)
      .all(req.org, direcao, antes, desde).map((x) => [x.chave, x.bytes]));
    // Só compara com o período anterior se houver dados desde o começo dele (senão a variação seria enganosa).
    const primeiro = db.prepare(`SELECT MIN(${col}) AS m FROM ${tab} WHERE organizacao_id = ? AND direcao = ?`).get(req.org, direcao).m;
    const comparavel = Boolean(primeiro && Date.parse(`${primeiro}${porHora ? '' : ':00'}Z`) <= agoraMs - 2 * horas * 3600_000 + horas * 360_000);
    const asns = ranking.filter((x) => x.chave.startsWith('as:')).map((x) => Number(x.chave.slice(3)));
    const nomesAsn = new Map(asns.length ? db.prepare(`SELECT asn, nome FROM asn_nomes WHERE asn IN (${asns.map(() => '?').join(',')})`).all(...asns).map((x) => [x.asn, x.nome]) : []);
    const nome = nomeChave(catalogo, nomesAsn);
    const total = ranking.reduce((s, x) => s + x.bytes, 0);
    // Pico: maior minuto (ou hora) do conteúdo no período, em bits/s.
    const seg = porHora ? 3600 : 60;
    const picos = new Map(db.prepare(`SELECT chave, MAX(b) AS pico FROM (SELECT chave, ${col}, SUM(bytes) AS b FROM ${tab} WHERE organizacao_id = ? AND direcao = ? AND ${col} >= ?
      GROUP BY chave, ${col}) GROUP BY chave`).all(req.org, direcao, desde).map((x) => [x.chave, (x.pico * 8) / seg]));
    const itens = ranking.map((x, i) => ({ posicao: i + 1, chave: x.chave, ...nome(x.chave), bytes: x.bytes, pacotes: x.pacotes, fluxos: x.fluxos,
      participacao: total ? x.bytes / total : 0, media_bps: (x.bytes * 8) / (horas * 3600), pico_bps: picos.get(x.chave) ?? 0,
      anterior_bytes: anterior.get(x.chave) ?? 0, variacao: comparavel && anterior.get(x.chave) ? x.bytes / anterior.get(x.chave) - 1 : null }));
    // Série empilhada: 8 maiores e "demais"
    const principais = itens.filter((x) => x.chave !== 'outros' && x.chave !== 'desconhecido').slice(0, 8).map((x) => x.chave);
    const passoMin = porHora ? (horas > 24 * 30 ? 24 * 60 : 60) : horas <= 6 ? 5 : 15;
    const blocoSql = porHora ? `CAST(strftime('%s', hora || ':00') / ${passoMin * 60} AS INTEGER) * ${passoMin * 60}` : `CAST(strftime('%s', minuto || ':00') / ${passoMin * 60} AS INTEGER) * ${passoMin * 60}`;
    const serie = new Map();
    for (const l of db.prepare(`SELECT ${blocoSql} AS b, chave, SUM(bytes) AS bytes FROM ${tab} WHERE organizacao_id = ? AND direcao = ? AND ${col} >= ? GROUP BY b, chave`)
      .all(req.org, direcao, desde)) {
      const ch = principais.includes(l.chave) ? l.chave : 'demais';
      if (!serie.has(l.b)) serie.set(l.b, {});
      const x = serie.get(l.b);
      x[ch] = (x[ch] ?? 0) + (l.bytes * 8) / (passoMin * 60);
    }
    const blocos = [...serie.keys()].sort((a, b) => a - b).filter((b) => (b + passoMin * 60) * 1000 <= agoraMs - 60_000);
    const series = [...principais, 'demais'].map((ch) => ({ chave: ch, nome: ch === 'demais' ? 'Demais' : nome(ch).nome, pontos: blocos.map((b) => [b * 1000, serie.get(b)[ch] ?? 0]) }));
    // Fluxo conteúdo → grupo de clientes
    const fluxo = db.prepare(`SELECT t.chave, t.grupo_id, g.nome AS grupo_nome, SUM(t.bytes) AS bytes FROM ${tab} t LEFT JOIN grupos_ip g ON g.id = t.grupo_id
      WHERE t.organizacao_id = ? AND t.direcao = ? AND t.${col} >= ? GROUP BY t.chave, t.grupo_id`).all(req.org, direcao, desde)
      .map((x) => ({ origem: principais.includes(x.chave) ? x.chave : 'demais', origem_nome: principais.includes(x.chave) ? nome(x.chave).nome : 'Demais', grupo_id: x.grupo_id,
        grupo_nome: x.grupo_nome ?? 'Sem grupo', bytes: x.bytes }))
      .reduce((m, x) => { const k = `${x.origem}|${x.grupo_id}`; const y = m.get(k); if (y) y.bytes += x.bytes; else m.set(k, { ...x }); return m; }, new Map());
    const identificado = itens.filter((x) => x.catalogado).reduce((s, x) => s + x.bytes, 0);
    const comAsn = itens.filter((x) => x.asn).reduce((s, x) => s + x.bytes, 0);
    const base = db.prepare('SELECT origem, faixas, importado_em FROM asn_base WHERE id = 1').get() ?? null;
    res.json({ horas, direcao, passo_min: passoMin, total_bytes: total, comparavel, itens: itens.slice(0, 100), series, fluxo: [...fluxo.values()].sort((a, b) => b.bytes - a.bytes),
      cobertura: { catalogo: total ? identificado / total : null, asn: total ? comAsn / total : null, desconhecido: total ? (itens.find((x) => x.chave === 'desconhecido')?.bytes ?? 0) / total : null },
      base_asn: base, gerado_em: agora() });
  });

  // Catálogo de conteúdos
  r.get('/conteudos', exigir('trafego.ver'), (req, res) => {
    conteudo.garantirCatalogo(db, req.org);
    const lista = db.prepare('SELECT * FROM conteudos WHERE organizacao_id = ? ORDER BY nome').all(req.org);
    res.json({ categorias: conteudo.CATEGORIAS, marcas: conteudo.MARCAS, base_asn: db.prepare('SELECT origem, faixas, importado_em FROM asn_base WHERE id = 1').get() ?? null,
      itens: lista.map((c) => ({ ...c, regras: db.prepare('SELECT id, tipo, valor FROM conteudo_regras WHERE conteudo_id = ? ORDER BY tipo, valor').all(c.id) })) });
  });
  const conteudoDe = (req) => {
    const c = db.prepare('SELECT * FROM conteudos WHERE id = ? AND organizacao_id = ?').get(Number(req.params.id), req.org);
    if (!c) throw new ErroNegocio('Conteúdo não encontrado.', 404);
    return c;
  };
  const regra = (req, conteudoId, b) => {
    const tipo = v.opcao(b?.tipo, 'o tipo da regra', ['asn', 'prefixo']);
    let valor;
    if (tipo === 'asn') valor = String(v.inteiro(String(b.valor ?? '').replace(/^AS/i, ''), 'o ASN', { min: 1, max: 4294967295 }));
    else {
      const p0 = lerPrefixo(b.valor, { estrito: true });
      if (!p0) throw new ErroNegocio('Prefixo inválido (ex.: 203.0.113.0/24, com os bits de host zerados).', 422);
      valor = p0.texto;
    }
    const ja = db.prepare('SELECT c.nome FROM conteudo_regras r JOIN conteudos c ON c.id = r.conteudo_id WHERE r.organizacao_id = ? AND r.tipo = ? AND r.valor = ?').get(req.org, tipo, valor);
    if (ja) throw new ErroNegocio(`${tipo === 'asn' ? `AS${valor}` : valor} já está em ${ja.nome}.`, 409);
    db.prepare('INSERT INTO conteudo_regras (organizacao_id, conteudo_id, tipo, valor, criado_em) VALUES (?, ?, ?, ?, ?)').run(req.org, conteudoId, tipo, valor, agora());
    return { tipo, valor };
  };
  r.post('/conteudos', exigir('ddos.configurar'), (req, res) => {
    const b = req.body ?? {};
    const t = agora();
    const marca = b.marca ? v.opcao(b.marca, 'o logo', conteudo.MARCAS) : null;
    const id = Number(db.prepare('INSERT INTO conteudos (organizacao_id, nome, categoria, marca, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.org, v.texto(b.nome, 'o nome', 80), v.opcao(b.categoria ?? 'outros', 'a categoria', Object.keys(conteudo.CATEGORIAS)), marca, t, t).lastInsertRowid);
    for (const x of [].concat(b.regras ?? [])) regra(req, id, x);
    registrar(db, req, 'conteudo_criado', { recurso: 'conteudo', recursoId: id, depois: b });
    res.status(201).json(db.prepare('SELECT * FROM conteudos WHERE id = ?').get(id));
  });
  r.patch('/conteudos/:id', exigir('ddos.configurar'), (req, res) => {
    const c = conteudoDe(req);
    const b = req.body ?? {};
    const d = { nome: b.nome !== undefined ? v.texto(b.nome, 'o nome', 80) : c.nome,
      categoria: b.categoria !== undefined ? v.opcao(b.categoria, 'a categoria', Object.keys(conteudo.CATEGORIAS)) : c.categoria,
      ativo: b.ativo !== undefined ? (v.booleano(b.ativo) ? 1 : 0) : c.ativo,
      marca: b.marca !== undefined ? (b.marca ? v.opcao(b.marca, 'o logo', conteudo.MARCAS) : null) : c.marca,
      aviso: b.aviso !== undefined ? v.opcional(b.aviso, 'o aviso', 300) : c.aviso };
    db.prepare('UPDATE conteudos SET nome = ?, categoria = ?, ativo = ?, marca = ?, aviso = ?, atualizado_em = ? WHERE id = ?')
      .run(d.nome, d.categoria, d.ativo, d.marca, d.aviso, agora(), c.id);
    registrar(db, req, 'conteudo_alterado', { recurso: 'conteudo', recursoId: c.id, antes: c, depois: d });
    res.json(db.prepare('SELECT * FROM conteudos WHERE id = ?').get(c.id));
  });
  r.post('/conteudos/:id/regras', exigir('ddos.configurar'), (req, res) => {
    const c = conteudoDe(req);
    const x = regra(req, c.id, req.body);
    registrar(db, req, 'conteudo_regra_incluida', { recurso: 'conteudo', recursoId: c.id, depois: x });
    res.status(201).json(x);
  });
  r.post('/conteudos/:id/regras/:rid/remover', exigir('ddos.configurar'), (req, res) => {
    const c = conteudoDe(req);
    const x = db.prepare('SELECT * FROM conteudo_regras WHERE id = ? AND conteudo_id = ?').get(Number(req.params.rid), c.id);
    if (!x) throw new ErroNegocio('Regra não encontrada.', 404);
    db.prepare('DELETE FROM conteudo_regras WHERE id = ?').run(x.id);
    registrar(db, req, 'conteudo_regra_removida', { recurso: 'conteudo', recursoId: c.id, antes: { tipo: x.tipo, valor: x.valor } });
    res.json({ ok: true });
  });

  return r;
};
