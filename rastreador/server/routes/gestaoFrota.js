'use strict';
/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

/**
 * Rotas da Gestão de Frota (/api/empresas/:eid/gestao/...). Módulo vendido à parte: só responde para a empresa em que o
 * master ligou o módulo. Consultas para todos da empresa; lançamentos para o gestor (o operador só consulta, pela regra geral).
 */
const { Router } = require('express');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { hoje, somarDias } = require('../lib/datas');
const gf = require('../lib/gestaoFrota');
const fin = require('../lib/financeiro');

module.exports = (db) => {
  const r = Router();
  r.use((req, _res, next) => {
    if (!req.empresa?.gestao_frota) return next(new ErroNegocio('A Gestão de Frota não está contratada para esta empresa. Fale com o suporte para ativar.', 403));
    next();
  });
  const eid = (req) => req.empresa.id;
  const uid = (req) => req.usuario.id;
  const ok = (res, x) => res.json(x ?? { ok: true });

  // Catálogos (tipos de componente, posições dos pneus, documentos e fornecedores).
  r.get('/catalogos', (_req, res) => res.json({
    componentes: gf.COMPONENTES, planos: gf.PLANOS, posicoes: gf.POSICOES, documentos: gf.TIPOS_DOCUMENTO, fornecedores: gf.TIPOS_FORNECEDOR,
    sulco_atencao_mm: gf.SULCO_ATENCAO_MM, sulco_limite_mm: gf.SULCO_LIMITE_MM,
  }));
  r.get('/painel', (req, res) => res.json(gf.painel(db, eid(req))));
  // Veículos e motoristas só com o que o módulo usa (sem posição nem rastreador): servem também ao usuário "Somente Gestão de Frota".
  r.get('/veiculos', (req, res) => res.json(db.prepare(`SELECT id, placa, descricao, tipo, marca, modelo, ano, cor, ativo, hodometro_m FROM veiculos
    WHERE empresa_id = ? ORDER BY placa`).all(eid(req))));
  r.get('/motoristas', (req, res) => res.json(db.prepare('SELECT id, nome, ativo FROM motoristas WHERE empresa_id = ? ORDER BY nome').all(eid(req))));

  // ---------- Ordens de serviço ----------
  r.get('/os', (req, res) => res.json(gf.listarOS(db, eid(req), { status: req.query.status, veiculoId: req.query.veiculo_id })));
  r.post('/os', (req, res) => {
    const x = gf.criarOS(db, eid(req), req.body, uid(req));
    registrar(db, req, 'os_aberta', { numero: x.numero });
    res.status(201).json(x);
  });
  r.get('/os/:id', (req, res) => res.json(gf.detalheOS(db, eid(req), req.params.id)));
  r.put('/os/:id', (req, res) => { gf.editarOS(db, eid(req), req.params.id, req.body); ok(res); });
  r.post('/os/:id/itens', (req, res) => res.status(201).json({ id: gf.adicionarItem(db, eid(req), req.params.id, req.body) }));
  r.delete('/os/:id/itens/:item', (req, res) => { gf.removerItem(db, eid(req), req.params.id, req.params.item); res.status(204).end(); });
  r.post('/os/:id/iniciar', (req, res) => { gf.iniciarOS(db, eid(req), req.params.id); ok(res); });
  r.post('/os/:id/concluir', (req, res) => {
    const x = gf.concluirOS(db, eid(req), req.params.id, req.body, uid(req));
    registrar(db, req, 'os_concluida', { id: Number(req.params.id), total_centavos: x.total_centavos });
    ok(res, x);
  });
  r.post('/os/:id/cancelar', (req, res) => { gf.cancelarOS(db, eid(req), req.params.id); registrar(db, req, 'os_cancelada', { id: Number(req.params.id) }); ok(res); });

  // ---------- Plano preventivo (componentes) ----------
  r.get('/componentes', (req, res) => res.json(gf.listarComponentes(db, eid(req), { veiculoId: req.query.veiculo_id })));
  r.post('/componentes', (req, res) => res.status(201).json({ id: gf.criarComponente(db, eid(req), req.body) }));
  r.put('/componentes/:id', (req, res) => { gf.editarComponente(db, eid(req), req.params.id, req.body); ok(res); });
  r.delete('/componentes/:id', (req, res) => { gf.excluirComponente(db, eid(req), req.params.id); res.status(204).end(); });
  // Troca registrada direto (sem OS): ex. o próprio motorista trocou a palheta.
  r.post('/componentes/:id/trocar', (req, res) => res.status(201).json({ id: gf.registrarTroca(db, eid(req), req.params.id, req.body) }));
  r.post('/veiculos/:vid/plano-padrao', (req, res) => res.status(201).json({ criados: gf.aplicarPlano(db, eid(req), req.params.vid) }));
  r.get('/veiculos/:vid/historico', (req, res) => res.json({
    componentes: gf.historicoComponentes(db, eid(req), req.params.vid),
    os: gf.listarOS(db, eid(req), { veiculoId: req.params.vid }),
  }));

  // ---------- Pneus ----------
  r.get('/pneus', (req, res) => res.json(gf.listarPneus(db, eid(req), { status: req.query.status || undefined, veiculoId: req.query.veiculo_id })));
  r.post('/pneus', (req, res) => res.status(201).json({ id: gf.cadastrarPneu(db, eid(req), req.body, uid(req)) }));
  r.get('/pneus/:id/historico', (req, res) => res.json(gf.historicoPneu(db, eid(req), req.params.id)));
  r.post('/pneus/:id/montar', (req, res) => { gf.montarPneu(db, eid(req), req.params.id, req.body, uid(req)); ok(res); });
  r.post('/pneus/:id/desmontar', (req, res) => { gf.desmontarPneu(db, eid(req), req.params.id, req.body, uid(req)); ok(res); });
  r.post('/pneus/:id/medir', (req, res) => ok(res, { estado: gf.medirPneu(db, eid(req), req.params.id, req.body, { usuarioId: uid(req) }) }));
  r.post('/pneus/:id/recapagem', (req, res) => { gf.enviarRecapagem(db, eid(req), req.params.id, uid(req)); ok(res); });
  r.post('/pneus/:id/voltar-recapagem', (req, res) => { gf.voltarRecapagem(db, eid(req), req.params.id, req.body, uid(req)); ok(res); });
  r.post('/pneus/:id/conserto', (req, res) => { gf.consertoPneu(db, eid(req), req.params.id, req.body, uid(req)); ok(res); });
  r.post('/pneus/:id/descartar', (req, res) => { gf.descartarPneu(db, eid(req), req.params.id, req.body, uid(req)); ok(res); });
  r.get('/veiculos/:vid/pneus', (req, res) => res.json(gf.pneusDoVeiculo(db, eid(req), req.params.vid)));
  r.post('/veiculos/:vid/rodizio', (req, res) => { gf.rodizio(db, eid(req), req.params.vid, req.body.trocas, uid(req)); ok(res); });

  // ---------- Documentos ----------
  r.get('/documentos', (req, res) => res.json(gf.listarDocumentos(db, eid(req))));
  r.post('/documentos', (req, res) => res.status(201).json({ id: gf.criarDocumento(db, eid(req), req.body) }));
  r.put('/documentos/:id', (req, res) => { gf.editarDocumento(db, eid(req), req.params.id, req.body); ok(res); });
  r.delete('/documentos/:id', (req, res) => {
    const d = gf.documentoDa(db, eid(req), req.params.id);
    db.prepare('DELETE FROM frota_documentos WHERE id = ?').run(d.id);
    res.status(204).end();
  });

  // ---------- Fornecedores ----------
  r.get('/fornecedores', (req, res) => res.json(gf.listarFornecedores(db, eid(req))));
  r.post('/fornecedores', (req, res) => res.status(201).json({ id: gf.salvarFornecedor(db, eid(req), req.body) }));
  r.put('/fornecedores/:id', (req, res) => { gf.salvarFornecedor(db, eid(req), req.body, req.params.id); ok(res); });
  r.delete('/fornecedores/:id', (req, res) => {
    const f = gf.fornecedorDa(db, eid(req), req.params.id);
    db.prepare('UPDATE frota_fornecedores SET ativo = 0 WHERE id = ?').run(f.id); // o histórico das OS continua com o nome
    res.status(204).end();
  });

  // ---------- Custos ----------
  r.get('/custos', (req, res) => {
    const ate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.ate ?? '')) ? req.query.ate : hoje();
    const de = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.de ?? '')) ? req.query.de : somarDias(ate, -29);
    if (de > ate || (Date.parse(ate) - Date.parse(de)) / 86_400_000 > 400) throw new ErroNegocio('Período inválido (até 400 dias).', 422);
    res.json(gf.custos(db, eid(req), de, ate));
  });

  // ---------- Financeiro: contas a pagar e a receber, contas e caixas, fluxo e resultado ----------
  const F = '/financeiro';
  r.get(`${F}/catalogos`, (req, res) => res.json({ tipos_conta: fin.TIPOS_CONTA, formas: fin.FORMAS, contas: fin.listarContas(db, eid(req)), categorias: fin.listarCategorias(db, eid(req)) }));
  r.get(`${F}/resumo`, (req, res) => res.json(fin.resumo(db, eid(req))));
  r.get(`${F}/resultado`, (req, res) => {
    const ate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.ate ?? '')) ? req.query.ate : hoje();
    const de = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.de ?? '')) ? req.query.de : `${ate.slice(0, 7)}-01`;
    if (de > ate) throw new ErroNegocio('Período inválido.', 422);
    res.json(fin.resultado(db, eid(req), de, ate));
  });
  r.get(`${F}/lancamentos`, (req, res) => res.json(fin.listar(db, eid(req), { tipo: req.query.tipo, status: req.query.status || 'aberto', de: req.query.de || undefined, ate: req.query.ate || undefined,
    veiculoId: req.query.veiculo_id || undefined, busca: req.query.busca || undefined })));
  r.post(`${F}/lancamentos`, (req, res) => {
    const ids = fin.criar(db, eid(req), req.body, uid(req));
    registrar(db, req, 'financeiro_conta_criada', { tipo: req.body.tipo, parcelas: ids.length });
    res.status(201).json({ ids });
  });
  r.put(`${F}/lancamentos/:id`, (req, res) => { fin.editar(db, eid(req), req.params.id, req.body); ok(res); });
  r.post(`${F}/lancamentos/:id/baixar`, (req, res) => {
    fin.baixar(db, eid(req), req.params.id, req.body);
    registrar(db, req, 'financeiro_baixa', { id: Number(req.params.id) });
    ok(res);
  });
  r.post(`${F}/lancamentos/:id/estornar`, (req, res) => {
    fin.estornar(db, eid(req), req.params.id);
    registrar(db, req, 'financeiro_estorno', { id: Number(req.params.id) });
    ok(res);
  });
  r.delete(`${F}/lancamentos/:id`, (req, res) => {
    const n = fin.excluir(db, eid(req), req.params.id, { todas: req.query.todas === '1' || req.body?.todas === true });
    registrar(db, req, 'financeiro_conta_excluida', { id: Number(req.params.id), quantidade: n });
    res.json({ excluidas: n });
  });
  r.get(`${F}/frota`, (req, res) => res.json(fin.pendenciasDaFrota(db, eid(req))));
  r.post(`${F}/frota`, (req, res) => res.status(201).json({ criadas: fin.importarDaFrota(db, eid(req), req.body.itens, uid(req)) }));
  r.get(`${F}/contas`, (req, res) => res.json({ contas: fin.listarContas(db, eid(req)), transferencias: fin.listarTransferencias(db, eid(req)) }));
  r.post(`${F}/contas`, (req, res) => res.status(201).json({ id: fin.salvarConta(db, eid(req), req.body) }));
  r.put(`${F}/contas/:id`, (req, res) => { fin.salvarConta(db, eid(req), req.body, req.params.id); ok(res); });
  r.post(`${F}/transferencias`, (req, res) => res.status(201).json({ id: fin.transferir(db, eid(req), req.body, uid(req)) }));
  r.delete(`${F}/transferencias/:id`, (req, res) => { fin.excluirTransferencia(db, eid(req), req.params.id); res.status(204).end(); });
  r.get(`${F}/categorias`, (req, res) => res.json(fin.listarCategorias(db, eid(req))));
  r.post(`${F}/categorias`, (req, res) => res.status(201).json({ id: fin.salvarCategoria(db, eid(req), req.body) }));
  r.put(`${F}/categorias/:id`, (req, res) => { fin.salvarCategoria(db, eid(req), req.body, req.params.id); ok(res); });

  // ---------- Detran (despesas do veículo com o governo: IPVA, licenciamento, seguro e multas) ----------
  r.get('/detran', (req, res) => res.json(gf.detran(db, eid(req), { ano: req.query.ano, mes: req.query.mes, veiculoId: req.query.veiculo_id || undefined })));

  return r;
};
