'use strict';

const { Router } = require('express');
const { agora, transacao } = require('../db');
const { exigir } = require('../auth');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { listaPaginada, csv } = require('../lib/http');
const { pode } = require('../lib/permissoes');
const { totalCentavos, precoMedio, ciclos, resumoCiclos } = require('../lib/combustivel');
const { vincular } = require('../lib/anexos');
const frota = require('../lib/frota');
const { limitesDoDia } = require('../lib/datas');
const v = require('../lib/validacao');

const COMBUSTIVEIS = ['gasolina', 'etanol', 'diesel', 'gnv', 'eletrico'];

module.exports = (db) => {
  const r = Router();
  const ehTecnico = (req) => req.usuario.perfil === 'tecnico';

  const veiculoDe = (req, id) => {
    const x = db.prepare('SELECT * FROM veiculos WHERE id = ? AND organizacao_id = ?').get(Number(id), req.org);
    if (!x) throw new ErroNegocio('Veículo não encontrado.', 404);
    if (ehTecnico(req) && !db.prepare('SELECT 1 FROM veiculo_responsaveis WHERE veiculo_id = ? AND tecnico_id = ? AND fim IS NULL').get(x.id, req.usuario.tecnico_id ?? -1)) {
      throw new ErroNegocio('Você só registra abastecimentos do veículo sob sua responsabilidade.', 403);
    }
    return x;
  };

  /** Lançamento retroativo: o odômetro precisa ficar entre o registro anterior e o posterior do mesmo veículo. */
  function validarOrdem(veiculoId, dataHora, odometro, ignorarId = -1) {
    const ant = db.prepare('SELECT id, data_hora, odometro_km FROM abastecimentos WHERE veiculo_id = ? AND data_hora <= ? AND id <> ? ORDER BY data_hora DESC, id DESC LIMIT 1')
      .get(veiculoId, dataHora, ignorarId);
    const pos = db.prepare('SELECT id, data_hora, odometro_km FROM abastecimentos WHERE veiculo_id = ? AND data_hora > ? AND id <> ? ORDER BY data_hora, id LIMIT 1')
      .get(veiculoId, dataHora, ignorarId);
    if (ant && odometro < ant.odometro_km) {
      throw new ErroNegocio(`Odômetro menor que o do abastecimento anterior (${ant.odometro_km} km em ${ant.data_hora.slice(0, 16).replace('T', ' ')} UTC).`, 422, { anterior: ant });
    }
    if (pos && odometro > pos.odometro_km) {
      throw new ErroNegocio(`Odômetro maior que o do abastecimento seguinte (${pos.odometro_km} km em ${pos.data_hora.slice(0, 16).replace('T', ' ')} UTC).`, 422, { posterior: pos });
    }
  }

  /** Filtro ?de=&ate= (datas de calendário inclusivas) pelo dia local da operação, não pelo dia UTC. */
  function periodo(req, f, p) {
    const fuso = req.usuario.fuso;
    if (req.query.de) { f.push('a.data_hora >= ?'); p.push(limitesDoDia(fuso, v.data(req.query.de, 'a data inicial')).inicio); }
    if (req.query.ate) { f.push('a.data_hora < ?'); p.push(limitesDoDia(fuso, v.data(req.query.ate, 'a data final')).fim); }
  }

  const comAnexos = (x) => ({ ...x, comprovantes: db.prepare("SELECT id, nome, mime FROM anexos WHERE recurso = 'abastecimento' AND recurso_id = ?").all(x.id) });

  r.get('/abastecimentos', exigir('combustivel.ver'), (req, res) => {
    const f = ['a.organizacao_id = ?'];
    const p = [req.org];
    if (ehTecnico(req)) { f.push('a.tecnico_id = ?'); p.push(req.usuario.tecnico_id ?? -1); }
    if (req.query.veiculo_id) { f.push('a.veiculo_id = ?'); p.push(Number(req.query.veiculo_id)); }
    if (req.query.tecnico_id) { f.push('a.tecnico_id = ?'); p.push(Number(req.query.tecnico_id)); }
    periodo(req, f, p);
    const lista = listaPaginada(db, `SELECT a.*, v.placa, v.modelo, t.nome AS tecnico_nome, COALESCE(f.nome, a.posto) AS posto_nome,
      (SELECT COUNT(*) FROM abastecimento_correcoes c WHERE c.abastecimento_id = a.id) AS correcoes,
      (SELECT COUNT(*) FROM anexos x WHERE x.recurso = 'abastecimento' AND x.recurso_id = a.id) AS comprovantes
      FROM abastecimentos a JOIN veiculos v ON v.id = a.veiculo_id LEFT JOIN tecnicos t ON t.id = a.tecnico_id LEFT JOIN fornecedores f ON f.id = a.fornecedor_id
      WHERE ${f.join(' AND ')} ORDER BY a.data_hora DESC, a.id DESC`, p, req.query);
    res.json(lista);
  });

  r.get('/abastecimentos/:id', exigir('combustivel.ver'), (req, res) => {
    const x = db.prepare('SELECT * FROM abastecimentos WHERE id = ? AND organizacao_id = ?').get(Number(req.params.id), req.org);
    if (!x || (ehTecnico(req) && x.tecnico_id !== req.usuario.tecnico_id)) throw new ErroNegocio('Abastecimento não encontrado.', 404);
    res.json({ ...comAnexos(x), correcoes: db.prepare(`SELECT c.*, u.nome AS usuario_nome FROM abastecimento_correcoes c LEFT JOIN usuarios u ON u.id = c.usuario_id
      WHERE abastecimento_id = ? ORDER BY c.id`).all(x.id) });
  });

  r.post('/abastecimentos', exigir('combustivel.lancar'), (req, res) => {
    const b = req.body ?? {};
    const veic = veiculoDe(req, b.veiculo_id);
    const d = {
      veiculo_id: veic.id,
      tecnico_id: ehTecnico(req) ? req.usuario.tecnico_id : (b.tecnico_id ? Number(b.tecnico_id) : null),
      data_hora: v.instante(b.data_hora, 'a data e hora'),
      combustivel: v.opcao(b.combustivel, 'o combustível', COMBUSTIVEIS),
      fornecedor_id: b.fornecedor_id ? Number(b.fornecedor_id) : null,
      posto: v.opcional(b.posto, 'o posto', 120),
      odometro_km: v.inteiro(b.odometro_km, 'o odômetro', { max: 5_000_000 }),
      litros_ml: v.escalado(b.litros, 'o volume (litros)', 3, { min: 1, max: 2_000_000 }),
      preco_milesimos: v.escalado(b.preco_litro, 'o preço por litro', 3, { min: 1, max: 100_000 }),
      tanque_cheio: v.booleano(b.tanque_cheio) ? 1 : 0,
      observacoes: v.opcional(b.observacoes, 'as observações', 500),
    };
    v.exigir(Date.parse(d.data_hora) <= Date.now() + 5 * 60_000, 'A data do abastecimento não pode estar no futuro.');
    if (d.tecnico_id && !db.prepare('SELECT 1 FROM tecnicos WHERE id = ? AND organizacao_id = ?').get(d.tecnico_id, req.org)) throw new ErroNegocio('Técnico não encontrado.', 422);
    if (d.fornecedor_id && !db.prepare("SELECT 1 FROM fornecedores WHERE id = ? AND organizacao_id = ? AND tipo = 'posto'").get(d.fornecedor_id, req.org)) {
      throw new ErroNegocio('Posto não encontrado.', 422);
    }
    d.total_centavos = totalCentavos(d.litros_ml, d.preco_milesimos);
    // Volume incompatível com o tanque (quando a capacidade é conhecida): o registro é aceito e sinalizado.
    d.alerta_volume = veic.tanque_litros && d.litros_ml > veic.tanque_litros * 1000 ? 1 : 0;
    const id = transacao(db, () => {
      validarOrdem(veic.id, d.data_hora, d.odometro_km);
      const nid = Number(db.prepare(`INSERT INTO abastecimentos (organizacao_id, veiculo_id, tecnico_id, data_hora, combustivel, fornecedor_id, posto, odometro_km, litros_ml,
        preco_milesimos, total_centavos, tanque_cheio, alerta_volume, observacoes, criado_por, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(req.org, d.veiculo_id, d.tecnico_id, d.data_hora, d.combustivel, d.fornecedor_id, d.posto, d.odometro_km, d.litros_ml, d.preco_milesimos, d.total_centavos,
          d.tanque_cheio, d.alerta_volume, d.observacoes, req.usuario.id, agora()).lastInsertRowid);
      vincular(db, req, 'abastecimento', nid, b.comprovante_id);
      frota.atualizarOdometro(db, veic.id, d.odometro_km, 'abastecimento', d.data_hora);
      return nid;
    });
    registrar(db, req, 'abastecimento_registrado', { recurso: 'abastecimento', recursoId: id, depois: d });
    const x = db.prepare('SELECT * FROM abastecimentos WHERE id = ?').get(id);
    res.status(201).json({ ...comAnexos(x), avisos: d.alerta_volume ? [`Volume maior que a capacidade do tanque (${veic.tanque_litros} L).`] : [] });
  });

  /** Correção autorizada: guarda o valor original, exige motivo e revalida a ordem do odômetro. */
  r.post('/abastecimentos/:id/corrigir', exigir('combustivel.corrigir'), (req, res) => {
    const a = db.prepare('SELECT * FROM abastecimentos WHERE id = ? AND organizacao_id = ?').get(Number(req.params.id), req.org);
    if (!a) throw new ErroNegocio('Abastecimento não encontrado.', 404);
    const b = req.body ?? {};
    const motivo = v.texto(b.motivo, 'o motivo da correção', 300);
    const novo = { ...a };
    if (b.odometro_km !== undefined) novo.odometro_km = v.inteiro(b.odometro_km, 'o odômetro', { max: 5_000_000 });
    if (b.litros !== undefined) novo.litros_ml = v.escalado(b.litros, 'o volume', 3, { min: 1, max: 2_000_000 });
    if (b.preco_litro !== undefined) novo.preco_milesimos = v.escalado(b.preco_litro, 'o preço por litro', 3, { min: 1, max: 100_000 });
    if (b.data_hora !== undefined) novo.data_hora = v.instante(b.data_hora, 'a data e hora');
    if (b.tanque_cheio !== undefined) novo.tanque_cheio = v.booleano(b.tanque_cheio) ? 1 : 0;
    novo.total_centavos = totalCentavos(novo.litros_ml, novo.preco_milesimos);
    const campos = ['odometro_km', 'litros_ml', 'preco_milesimos', 'data_hora', 'tanque_cheio', 'total_centavos'].filter((c) => novo[c] !== a[c]);
    v.exigir(campos.length, 'Nenhum valor foi alterado.');
    transacao(db, () => {
      validarOrdem(a.veiculo_id, novo.data_hora, novo.odometro_km, a.id);
      db.prepare('UPDATE abastecimentos SET odometro_km = ?, litros_ml = ?, preco_milesimos = ?, data_hora = ?, tanque_cheio = ?, total_centavos = ? WHERE id = ?')
        .run(novo.odometro_km, novo.litros_ml, novo.preco_milesimos, novo.data_hora, novo.tanque_cheio, novo.total_centavos, a.id);
      const ins = db.prepare('INSERT INTO abastecimento_correcoes (abastecimento_id, campo, valor_anterior, valor_novo, motivo, usuario_id, em) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const c of campos) ins.run(a.id, c, String(a[c]), String(novo[c]), motivo, req.usuario.id, agora());
    });
    registrar(db, req, 'abastecimento_corrigido', { recurso: 'abastecimento', recursoId: a.id, antes: a, depois: { ...novo, motivo } });
    res.json(db.prepare('SELECT * FROM abastecimentos WHERE id = ?').get(a.id));
  });

  /** Consumo e custos por veículo, com ciclos válidos; e totais por técnico e por posto. */
  r.get('/resumo', exigir('combustivel.ver'), (req, res) => {
    v.exigir(!ehTecnico(req), 'Resumo disponível para a gestão da frota.');
    const f = ['a.organizacao_id = ?'];
    const p = [req.org];
    periodo(req, f, p);
    if (req.query.veiculo_id) { f.push('a.veiculo_id = ?'); p.push(Number(req.query.veiculo_id)); }
    const lista = db.prepare(`SELECT a.*, v.placa, v.modelo, t.nome AS tecnico_nome, COALESCE(fo.nome, a.posto, 'Não informado') AS posto_nome FROM abastecimentos a
      JOIN veiculos v ON v.id = a.veiculo_id LEFT JOIN tecnicos t ON t.id = a.tecnico_id LEFT JOIN fornecedores fo ON fo.id = a.fornecedor_id
      WHERE ${f.join(' AND ')} ORDER BY a.data_hora`).all(...p);
    const agrupar = (chave, nome) => {
      const m = new Map();
      for (const x of lista) {
        const k = x[chave] ?? 0;
        if (!m.has(k)) m.set(k, { id: x[chave], nome: x[nome] ?? 'Não informado', itens: [] });
        m.get(k).itens.push(x);
      }
      return [...m.values()];
    };
    const resumo = (itens) => ({ lancamentos: itens.length, litros_ml: itens.reduce((a, x) => a + x.litros_ml, 0),
      total_centavos: itens.reduce((a, x) => a + x.total_centavos, 0), preco_medio_milesimos: precoMedio(itens) });
    const veiculos = agrupar('veiculo_id', 'placa').map((g) => {
      const cs = ciclos(g.itens);
      return { veiculo_id: g.id, placa: g.nome, modelo: g.itens[0].modelo, ...resumo(g.itens), consumo: resumoCiclos(cs), ciclos: cs };
    });
    res.json({
      total: resumo(lista),
      por_veiculo: veiculos,
      por_tecnico: agrupar('tecnico_id', 'tecnico_nome').map((g) => ({ tecnico_id: g.id, nome: g.nome, ...resumo(g.itens) })),
      por_posto: agrupar('posto_nome', 'posto_nome').map((g) => ({ posto: g.nome, ...resumo(g.itens) })),
      observacao: 'Custo de combustível por km considera só o combustível dos ciclos válidos; não é o custo operacional total do veículo.',
    });
  });

  r.get('/exportar.csv', exigir('combustivel.ver'), (req, res) => {
    v.exigir(!ehTecnico(req) || pode(req.usuario.perfil, 'combustivel.comprovantes'), 'Exportação disponível para a gestão da frota.');
    const lista = db.prepare(`SELECT a.*, v.placa, t.nome AS tecnico_nome, COALESCE(fo.nome, a.posto) AS posto_nome FROM abastecimentos a JOIN veiculos v ON v.id = a.veiculo_id
      LEFT JOIN tecnicos t ON t.id = a.tecnico_id LEFT JOIN fornecedores fo ON fo.id = a.fornecedor_id WHERE a.organizacao_id = ? ORDER BY a.data_hora`).all(req.org);
    const n = (x, casas) => (x / 10 ** casas).toFixed(casas).replace('.', ',');
    registrar(db, req, 'abastecimentos_exportados', { recurso: 'abastecimento', depois: { linhas: lista.length } });
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="abastecimentos.csv"' }).send(csv([
      ['Data/hora (UTC)', 'Placa', 'Técnico', 'Posto', 'Combustível', 'Odômetro (km)', 'Litros', 'Preço/L (R$)', 'Total (R$)', 'Tanque cheio', 'Observações'],
      ...lista.map((x) => [x.data_hora, x.placa, x.tecnico_nome, x.posto_nome, x.combustivel, x.odometro_km, n(x.litros_ml, 3), n(x.preco_milesimos, 3),
        n(x.total_centavos, 2), x.tanque_cheio ? 'sim' : 'não', x.observacoes]),
    ]));
  });

  return r;
};
