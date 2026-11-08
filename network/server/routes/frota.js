'use strict';

const { Router } = require('express');
const { agora } = require('../db');
const { exigir } = require('../auth');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { listaPaginada, like, conferirVersao } = require('../lib/http');
const frota = require('../lib/frota');
const { vincular } = require('../lib/anexos');
const v = require('../lib/validacao');

const CATEGORIAS = ['passeio', 'utilitario', 'picape', 'van', 'caminhao', 'moto', 'outro'];
const COMBUSTIVEIS = ['flex', 'gasolina', 'etanol', 'diesel', 'gnv', 'eletrico'];
const STATUS_BASE = ['disponivel', 'em_operacao', 'reservado', 'inativo'];
const TIPOS_RESTRICAO = ['oficina', 'documento', 'sinistro', 'administrativa'];
const TIPOS_DOC = ['crlv', 'seguro', 'licenciamento', 'ipva', 'vistoria', 'outro'];
const TIPOS_FORNECEDOR = ['oficina', 'posto', 'lavagem', 'pecas', 'outro'];

function dadosVeiculo(b, atual = {}) {
  const val = (k, f) => (b[k] !== undefined ? f(b[k]) : atual[k] ?? null);
  return {
    placa: val('placa', v.placa),
    identificacao: val('identificacao', (x) => v.opcional(x, 'a identificação', 40)),
    marca: val('marca', (x) => v.opcional(x, 'a marca', 60)),
    modelo: val('modelo', (x) => v.texto(x, 'o modelo', 80)),
    ano: val('ano', (x) => v.inteiroOpcional(x, 'o ano', { min: 1950, max: new Date().getFullYear() + 1 })),
    categoria: val('categoria', (x) => v.opcao(x, 'a categoria', CATEGORIAS)) ?? 'utilitario',
    combustivel: val('combustivel', (x) => v.opcao(x, 'o combustível', COMBUSTIVEIS)) ?? 'flex',
    tanque_litros: val('tanque_litros', (x) => v.inteiroOpcional(x, 'a capacidade do tanque', { min: 1, max: 1000 })),
    status_base: val('status_base', (x) => v.opcao(x, 'o estado', STATUS_BASE)) ?? 'disponivel',
    observacoes: val('observacoes', (x) => v.opcional(x, 'as observações', 1000)),
  };
}

module.exports = (db) => {
  const r = Router();
  const buscar = (req, id) => {
    const x = db.prepare('SELECT * FROM veiculos WHERE id = ? AND organizacao_id = ?').get(Number(id), req.org);
    if (!x) throw new ErroNegocio('Veículo não encontrado.', 404);
    return x;
  };
  const responsavel = db.prepare(`SELECT vr.*, t.nome AS tecnico_nome FROM veiculo_responsaveis vr JOIN tecnicos t ON t.id = vr.tecnico_id
    WHERE vr.veiculo_id = ? AND vr.fim IS NULL`);
  const comStatus = (x) => {
    const restricoes = frota.restricoesAtivas(db, x.id);
    const resp = responsavel.get(x.id);
    return { ...x, status: frota.statusEfetivo(x, restricoes), restricoes, responsavel: resp ? { tecnico_id: resp.tecnico_id, nome: resp.tecnico_nome, desde: resp.inicio } : null };
  };

  // ---------------- Veículos ----------------
  r.get('/veiculos', exigir('frota.ver'), (req, res) => {
    const f = ['organizacao_id = ?'];
    const p = [req.org];
    if (req.query.busca) { f.push('(placa LIKE ? ESCAPE \'\\\' OR modelo LIKE ? ESCAPE \'\\\' OR identificacao LIKE ? ESCAPE \'\\\')'); const t = like(String(req.query.busca).replace(/[\s-]/g, '')); p.push(t, like(req.query.busca), like(req.query.busca)); }
    if (req.query.ativos === '1') f.push("status_base <> 'inativo'");
    const lista = listaPaginada(db, `SELECT * FROM veiculos WHERE ${f.join(' AND ')} ORDER BY placa`, p, req.query, { padrao: 100 });
    lista.itens = lista.itens.map(comStatus);
    if (req.query.status) lista.itens = lista.itens.filter((x) => x.status === req.query.status);
    res.json(lista);
  });

  r.post('/veiculos', exigir('frota.editar'), (req, res) => {
    const d = dadosVeiculo(req.body ?? {});
    v.exigir(d.placa && d.modelo, 'Informe placa e modelo.');
    if (db.prepare('SELECT 1 FROM veiculos WHERE organizacao_id = ? AND placa = ?').get(req.org, d.placa)) {
      throw new ErroNegocio(`A placa ${d.placa} já está cadastrada nesta organização.`, 409);
    }
    const odo = v.inteiroOpcional(req.body.odometro_km, 'o odômetro', { max: 5_000_000 });
    const id = Number(db.prepare(`INSERT INTO veiculos (organizacao_id, placa, identificacao, marca, modelo, ano, categoria, combustivel, tanque_litros, status_base,
      observacoes, odometro_km, odometro_fonte, odometro_em, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.org, d.placa, d.identificacao, d.marca, d.modelo, d.ano, d.categoria, d.combustivel, d.tanque_litros, d.status_base, d.observacoes,
        odo, odo === null ? null : 'manual', odo === null ? null : agora(), agora()).lastInsertRowid);
    registrar(db, req, 'veiculo_criado', { recurso: 'veiculo', recursoId: id, depois: { ...d, odometro_km: odo } });
    res.status(201).json(comStatus(buscar(req, id)));
  });

  r.get('/veiculos/:id', exigir('frota.ver'), (req, res) => {
    const x = comStatus(buscar(req, req.params.id));
    const docs = req.usuario.perfil === 'tecnico' ? [] : db.prepare('SELECT * FROM veiculo_documentos WHERE veiculo_id = ? ORDER BY vencimento').all(x.id);
    res.json({
      ...x,
      disponibilidade: frota.disponibilidade(db, x),
      historico_responsaveis: db.prepare(`SELECT vr.*, t.nome AS tecnico_nome FROM veiculo_responsaveis vr JOIN tecnicos t ON t.id = vr.tecnico_id
        WHERE vr.veiculo_id = ? ORDER BY vr.inicio DESC LIMIT 30`).all(x.id),
      historico_restricoes: db.prepare(`SELECT r.*, u.nome AS criado_por_nome, l.nome AS liberado_por_nome FROM veiculo_restricoes r
        LEFT JOIN usuarios u ON u.id = r.criado_por LEFT JOIN usuarios l ON l.id = r.liberado_por WHERE r.veiculo_id = ? ORDER BY r.inicio DESC LIMIT 30`).all(x.id),
      documentos: docs.map((d) => ({ ...d, anexos: db.prepare("SELECT id, nome, mime FROM anexos WHERE recurso = 'veiculo_documento' AND recurso_id = ?").all(d.id) })),
      manutencoes: db.prepare(`SELECT m.id, m.tipo, m.descricao, m.status, m.data_planejada, m.concluido_em, m.custo_previsto_centavos, m.custo_realizado_centavos,
        f.nome AS fornecedor FROM manutencoes m LEFT JOIN fornecedores f ON f.id = m.fornecedor_id WHERE m.veiculo_id = ? ORDER BY m.id DESC LIMIT 20`).all(x.id),
      abastecimentos: db.prepare('SELECT id, data_hora, litros_ml, total_centavos, odometro_km, tanque_cheio FROM abastecimentos WHERE veiculo_id = ? ORDER BY data_hora DESC LIMIT 10').all(x.id),
      chamados: db.prepare('SELECT id, numero, titulo, status, agendado_para FROM chamados WHERE veiculo_id = ? ORDER BY id DESC LIMIT 10').all(x.id),
      dispositivo: db.prepare('SELECT dispositivo_id, fonte, inicio FROM dispositivos_vinculos WHERE veiculo_id = ? AND fim IS NULL').get(x.id) ?? null,
    });
  });

  r.patch('/veiculos/:id', exigir('frota.editar'), (req, res) => {
    const antes = buscar(req, req.params.id);
    conferirVersao(antes.versao, req.body?.versao);
    const d = dadosVeiculo(req.body ?? {}, antes);
    if (d.placa !== antes.placa && db.prepare('SELECT 1 FROM veiculos WHERE organizacao_id = ? AND placa = ? AND id <> ?').get(req.org, d.placa, antes.id)) {
      throw new ErroNegocio(`A placa ${d.placa} já está cadastrada nesta organização.`, 409);
    }
    let odo = antes.odometro_km;
    if (req.body.odometro_km !== undefined && req.body.odometro_km !== '' && Number(req.body.odometro_km) !== antes.odometro_km) {
      odo = v.inteiro(req.body.odometro_km, 'o odômetro', { max: 5_000_000 });
      if (antes.odometro_km !== null && odo < antes.odometro_km) v.exigir(String(req.body.motivo_odometro ?? '').trim(), 'Para reduzir o odômetro, informe o motivo da correção.');
    }
    db.prepare(`UPDATE veiculos SET placa = ?, identificacao = ?, marca = ?, modelo = ?, ano = ?, categoria = ?, combustivel = ?, tanque_litros = ?, status_base = ?,
      observacoes = ?, odometro_km = ?, odometro_fonte = CASE WHEN ? THEN 'manual' ELSE odometro_fonte END, odometro_em = CASE WHEN ? THEN ? ELSE odometro_em END,
      versao = versao + 1 WHERE id = ?`).run(d.placa, d.identificacao, d.marca, d.modelo, d.ano, d.categoria, d.combustivel, d.tanque_litros, d.status_base,
      d.observacoes, odo, odo !== antes.odometro_km ? 1 : 0, odo !== antes.odometro_km ? 1 : 0, agora(), antes.id);
    registrar(db, req, 'veiculo_alterado', { recurso: 'veiculo', recursoId: antes.id, antes, depois: { ...d, odometro_km: odo, motivo_odometro: req.body.motivo_odometro } });
    res.json(comStatus(buscar(req, antes.id)));
  });

  r.get('/veiculos/:id/disponibilidade', exigir('frota.ver'), (req, res) => res.json(frota.disponibilidade(db, buscar(req, req.params.id))));

  // Responsável (técnico) pelo veículo, com início e fim.
  r.post('/veiculos/:id/responsavel', exigir('frota.escalar'), (req, res) => {
    const x = buscar(req, req.params.id);
    const motivo = v.opcional(req.body?.motivo, 'o motivo', 300);
    const tecnicoId = req.body?.tecnico_id ? Number(req.body.tecnico_id) : null;
    if (tecnicoId) {
      const t = db.prepare("SELECT * FROM tecnicos WHERE id = ? AND organizacao_id = ? AND status <> 'inativo'").get(tecnicoId, req.org);
      if (!t) throw new ErroNegocio('Técnico não encontrado.', 404);
      frota.exigirDisponivel(db, x);
    }
    const t = agora();
    require('../db').transacao(db, () => {
      db.prepare('UPDATE veiculo_responsaveis SET fim = ? WHERE veiculo_id = ? AND fim IS NULL').run(t, x.id);
      if (tecnicoId) {
        db.prepare('INSERT INTO veiculo_responsaveis (organizacao_id, veiculo_id, tecnico_id, inicio, motivo, criado_por) VALUES (?, ?, ?, ?, ?, ?)')
          .run(req.org, x.id, tecnicoId, t, motivo, req.usuario.id);
      }
    });
    registrar(db, req, tecnicoId ? 'veiculo_responsavel_definido' : 'veiculo_responsavel_encerrado', { recurso: 'veiculo', recursoId: x.id, depois: { tecnico_id: tecnicoId, motivo } });
    res.json(comStatus(buscar(req, x.id)));
  });

  // Restrições (bloqueios) e liberação com motivo.
  r.post('/veiculos/:id/restricoes', exigir('frota.editar'), (req, res) => {
    const x = buscar(req, req.params.id);
    const d = { tipo: v.opcao(req.body?.tipo, 'o tipo', TIPOS_RESTRICAO), motivo: v.texto(req.body?.motivo, 'o motivo', 300) };
    const id = frota.abrirRestricao(db, req, x.id, d);
    registrar(db, req, 'veiculo_bloqueado', { recurso: 'veiculo', recursoId: x.id, depois: { restricao_id: id, ...d } });
    res.status(201).json(comStatus(buscar(req, x.id)));
  });

  r.post('/restricoes/:rid/liberar', exigir('frota.editar'), (req, res) => {
    const rs = db.prepare('SELECT * FROM veiculo_restricoes WHERE id = ? AND organizacao_id = ? AND fim IS NULL').get(Number(req.params.rid), req.org);
    if (!rs) throw new ErroNegocio('Restrição não encontrada ou já liberada.', 404);
    if (rs.tipo === 'manutencao') throw new ErroNegocio('Esta restrição é de uma ordem de manutenção: ela é liberada ao concluir ou cancelar a ordem.', 422);
    const motivo = v.texto(req.body?.motivo, 'o motivo da liberação', 300);
    frota.liberarRestricao(db, req, rs.id, motivo);
    registrar(db, req, 'veiculo_liberado', { recurso: 'veiculo', recursoId: rs.veiculo_id, antes: rs, depois: { motivo } });
    res.json(comStatus(buscar(req, rs.veiculo_id)));
  });

  // ---------------- Documentos ----------------
  r.post('/veiculos/:id/documentos', exigir('frota.documentos'), (req, res) => {
    const x = buscar(req, req.params.id);
    const b = req.body ?? {};
    const d = { tipo: v.opcao(b.tipo, 'o tipo', TIPOS_DOC), numero: v.opcional(b.numero, 'o número', 60), vencimento: v.dataOpcional(b.vencimento, 'o vencimento'),
      observacoes: v.opcional(b.observacoes, 'as observações', 500) };
    const id = require('../db').transacao(db, () => {
      const nid = Number(db.prepare(`INSERT INTO veiculo_documentos (organizacao_id, veiculo_id, tipo, numero, vencimento, observacoes, criado_por, criado_em)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(req.org, x.id, d.tipo, d.numero, d.vencimento, d.observacoes, req.usuario.id, agora()).lastInsertRowid);
      vincular(db, req, 'veiculo_documento', nid, b.anexo_id);
      return nid;
    });
    registrar(db, req, 'documento_criado', { recurso: 'veiculo', recursoId: x.id, depois: { documento_id: id, ...d } });
    res.status(201).json({ id, ...d });
  });

  r.get('/documentos/vencendo', exigir('frota.documentos'), (req, res) => {
    const dias = Math.min(365, Number(req.query.dias) || 30);
    const limite = new Date(Date.now() + dias * 86400_000).toISOString().slice(0, 10);
    res.json(db.prepare(`SELECT d.*, v.placa, v.modelo FROM veiculo_documentos d JOIN veiculos v ON v.id = d.veiculo_id
      WHERE d.organizacao_id = ? AND d.vencimento IS NOT NULL AND d.vencimento <= ? ORDER BY d.vencimento`).all(req.org, limite));
  });

  // ---------------- Fornecedores ----------------
  r.get('/fornecedores', exigir('frota.ver', 'manutencao.ver'), (req, res) => {
    const f = ['organizacao_id = ?'];
    const p = [req.org];
    if (req.query.tipo) { f.push('tipo = ?'); p.push(String(req.query.tipo)); }
    if (req.query.busca) { f.push("nome LIKE ? ESCAPE '\\'"); p.push(like(req.query.busca)); }
    if (req.query.ativos !== '0') f.push('ativo = 1');
    res.json(listaPaginada(db, `SELECT * FROM fornecedores WHERE ${f.join(' AND ')} ORDER BY nome`, p, req.query, { padrao: 100 }));
  });

  const dadosFornecedor = (b, a = {}) => {
    const val = (k, fn) => (b[k] !== undefined ? fn(b[k]) : a[k] ?? null);
    return {
      nome: val('nome', (x) => v.texto(x, 'o nome', 120)), tipo: val('tipo', (x) => v.opcao(x, 'o tipo', TIPOS_FORNECEDOR)),
      documento: val('documento', (x) => { const t = v.digitos(x); if (!t) return null; v.exigir(v.cnpjValido(t) || v.cpfValido(t), 'CNPJ/CPF inválido.'); return t; }),
      contato: val('contato', (x) => v.opcional(x, 'o contato', 120)), telefone: val('telefone', (x) => (x ? v.telefone(x) : null)),
      email: val('email', (x) => (x ? v.email(x) : null)), endereco: val('endereco', (x) => v.opcional(x, 'o endereço', 200)),
      especialidades: val('especialidades', (x) => v.opcional(x, 'as especialidades', 300)), observacoes: val('observacoes', (x) => v.opcional(x, 'as observações', 1000)),
      ativo: b.ativo !== undefined ? (v.booleano(b.ativo) ? 1 : 0) : a.ativo ?? 1,
    };
  };

  r.post('/fornecedores', exigir('manutencao.editar'), (req, res) => {
    const d = dadosFornecedor(req.body ?? {});
    v.exigir(d.nome && d.tipo, 'Informe nome e tipo.');
    const id = Number(db.prepare(`INSERT INTO fornecedores (organizacao_id, nome, tipo, documento, contato, telefone, email, endereco, especialidades, observacoes, ativo, criado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.org, d.nome, d.tipo, d.documento, d.contato, d.telefone, d.email, d.endereco, d.especialidades, d.observacoes, d.ativo, agora()).lastInsertRowid);
    registrar(db, req, 'fornecedor_criado', { recurso: 'fornecedor', recursoId: id, depois: d });
    res.status(201).json({ id, ...d });
  });

  r.patch('/fornecedores/:id', exigir('manutencao.editar'), (req, res) => {
    const a = db.prepare('SELECT * FROM fornecedores WHERE id = ? AND organizacao_id = ?').get(Number(req.params.id), req.org);
    if (!a) throw new ErroNegocio('Fornecedor não encontrado.', 404);
    const d = dadosFornecedor(req.body ?? {}, a);
    db.prepare(`UPDATE fornecedores SET nome = ?, tipo = ?, documento = ?, contato = ?, telefone = ?, email = ?, endereco = ?, especialidades = ?, observacoes = ?, ativo = ?
      WHERE id = ?`).run(d.nome, d.tipo, d.documento, d.contato, d.telefone, d.email, d.endereco, d.especialidades, d.observacoes, d.ativo, a.id);
    registrar(db, req, 'fornecedor_alterado', { recurso: 'fornecedor', recursoId: a.id, antes: a, depois: d });
    res.json({ id: a.id, ...d });
  });

  return r;
};
