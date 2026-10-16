'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar, dia } = require('./helpers');
const totp = require('../server/lib/totp');
const { inicioMes, fimMes, somarMeses, mes } = require('../server/lib/datas');

const EMPRESA = { razao_social: 'Mercado Bom Preço Ltda', cnpj: '11.222.333/0001-81', inicio_contrato: dia(-200), mensalidade_centavos: 150000 };

test('Módulos do BPO', async (t) => {
  const api = await iniciar();
  t.after(api.fechar);
  let empresa, conta, cats, centros, analistaTk, supervisorTk;
  const base = () => `/empresas/${empresa}`;
  const cat = (nome) => cats.find((c) => c.nome === nome).id;
  const pagar = (corpo, tk) => api.post(`${base()}/lancamentos`, { tipo: 'pagar', vencimento: dia(5), categoria_id: cat('Aluguel e condomínio'), ...corpo }, tk);

  await t.test('preparação', async () => {
    empresa = (await api.post('/empresas', EMPRESA)).dados.id;
    cats = (await api.get(`${base()}/categorias`)).dados.itens;
    conta = (await api.post(`${base()}/contas-bancarias`, { descricao: 'Movimento', banco: 'PAY AX', saldo_inicial_centavos: 100_000, data_saldo_inicial: dia(-200) })).dados.id;
    await api.post(`${base()}/centros`, { nome: 'Loja Centro' });
    await api.post(`${base()}/centros`, { nome: 'Loja Bairro' });
    centros = (await api.get(`${base()}/centros`)).dados;
    const a = await api.post('/usuarios', { nome: 'Ana', email: 'ana@bpo.payax.com.br', senha: 'senha-forte-1', perfil: 'analista' });
    await api.post('/usuarios', { nome: 'Sueli', email: 'sueli@bpo.payax.com.br', senha: 'senha-forte-2', perfil: 'supervisor' });
    await api.patch(`/empresas/${empresa}`, { analista_id: a.dados.id });
    analistaTk = await api.login('ana@bpo.payax.com.br', 'senha-forte-1');
    supervisorTk = await api.login('sueli@bpo.payax.com.br', 'senha-forte-2');
  });

  await t.test('responsáveis da empresa: só o gestor cria; acesso ao Portal gera senha provisória', async () => {
    assert.equal((await api.post(`${base()}/responsaveis`, { nome: 'X' }, analistaTk)).status, 403);
    const r = await api.post(`${base()}/responsaveis`, { nome: 'Marta Lima', cargo: 'Sócia', email: 'marta@bompreco.com.br', acesso_portal: true, pode_aprovar: true, limite_aprovacao_centavos: 500_000 });
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    assert.match(r.dados.senha_provisoria, /^[A-Za-z2-9]{10}$/);
    t.marta = r.dados;
    assert.equal((await api.post(`${base()}/responsaveis`, { nome: 'Outro', email: 'MARTA@bompreco.com.br', acesso_portal: true })).status, 409);
    assert.equal((await api.get(`${base()}/responsaveis`, analistaTk)).dados.length, 1);
  });

  await t.test('recorrência mensal repete o valor cheio', async () => {
    const r = await pagar({ descricao: 'Aluguel', valor_centavos: 300_000, repeticoes: 12, vencimento: dia(10) });
    assert.equal(r.dados.ids.length, 12);
    const l = (await api.get(`${base()}/lancamentos/${r.dados.ids[11]}`)).dados;
    assert.equal(l.valor_centavos, 300_000);
    assert.equal(l.recorrente, 1);
    assert.equal(l.parcelas.length, 12);
    assert.equal((await pagar({ descricao: 'X', valor_centavos: 100, parcelas: 2, repeticoes: 2 })).status, 422);
  });

  await t.test('rateio entre centros de custo vale na DRE e no resultado por centro', async () => {
    const [c1, c2] = centros.filter((c) => c.nome.startsWith('Loja')).map((c) => c.id);
    assert.equal((await pagar({ descricao: 'Energia', valor_centavos: 10_000, rateio: [{ centro_custo_id: c1, percentual: 60 }, { centro_custo_id: c2, percentual: 30 }] })).status, 422, 'precisa somar 100%');
    const r = await pagar({ descricao: 'Energia', valor_centavos: 10_000, competencia: dia(), categoria_id: cat('Energia, água e internet'),
      rateio: [{ centro_custo_id: c1, percentual: 70 }, { centro_custo_id: c2, percentual: 30 }] });
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    const det = (await api.get(`${base()}/lancamentos/${r.dados.ids[0]}`)).dados;
    assert.deepEqual(det.rateio.map((x) => x.percentual), [7000, 3000]);
    const de = inicioMes(dia());
    const ate = fimMes(dia());
    const linha = (d) => d.linhas.find((l) => l.rotulo === 'Despesas operacionais').categorias.find((c) => c.nome === 'Energia, água e internet')?.total;
    assert.equal(linha((await api.get(`${base()}/dre?de=${de}&ate=${ate}&centro_custo_id=${c1}`)).dados), 7_000);
    assert.equal(linha((await api.get(`${base()}/dre?de=${de}&ate=${ate}&centro_custo_id=${c2}`)).dados), 3_000);
    const pc = (await api.get(`${base()}/resultado-centros?de=${de}&ate=${ate}`)).dados.linhas;
    assert.equal(pc.find((x) => x.centro_custo_id === c1).despesas_centavos, 7_000);
  });

  await t.test('baixa parcial deixa o saldo em aberto', async () => {
    const r = await api.post(`${base()}/lancamentos`, { tipo: 'receber', descricao: 'Mensalidade cliente', valor_centavos: 50_000, vencimento: dia(-1), categoria_id: cat('Prestação de serviços') });
    const id = r.dados.ids[0];
    assert.equal((await api.post(`${base()}/lancamentos/${id}/baixa`, { conta_bancaria_id: conta, valor_principal_centavos: 60_000 })).status, 422);
    assert.equal((await api.post(`${base()}/lancamentos/${id}/baixa`, { conta_bancaria_id: conta, valor_principal_centavos: 20_000, data: dia(-1) })).status, 200);
    const l = (await api.get(`${base()}/lancamentos/${id}`)).dados;
    assert.equal(l.status, 'pago');
    assert.equal(l.valor_centavos, 20_000);
    assert.equal(l.saldos.length, 1);
    const saldo = (await api.get(`${base()}/lancamentos/${l.saldos[0].id}`)).dados;
    assert.equal(saldo.valor_centavos, 30_000);
    assert.equal(saldo.status, 'aberto');
    assert.equal(saldo.origem.id, id);
  });

  let pagamento;
  await t.test('aprovação de pagamentos: conferência, alçada, segregação e bloqueio da baixa', async () => {
    assert.equal((await api.patch(`${base()}/aprovacoes/config`, { aprovacao_ativa: true, aprovacao_acima_centavos: 100_000 }, analistaTk)).status, 403);
    assert.equal((await api.patch(`${base()}/aprovacoes/config`, { aprovacao_ativa: true, aprovacao_acima_centavos: 100_000 })).status, 204);
    const pequeno = (await pagar({ descricao: 'Material', valor_centavos: 5_000, categoria_id: cat('Material de escritório') }, analistaTk)).dados.ids[0];
    assert.equal((await api.get(`${base()}/lancamentos/${pequeno}`)).dados.aprovacao, 'dispensada');
    pagamento = (await pagar({ descricao: 'Fornecedor grande', valor_centavos: 400_000, categoria_id: cat('Compra de mercadorias') }, analistaTk)).dados.ids[0];
    assert.equal((await api.get(`${base()}/lancamentos/${pagamento}`)).dados.aprovacao, 'conferencia');
    const baixa = await api.post(`${base()}/lancamentos/${pagamento}/baixa`, { conta_bancaria_id: conta });
    assert.equal(baixa.status, 409);
    assert.match(baixa.dados.erro, /aprovação/);
    assert.equal((await api.post(`${base()}/aprovacoes/${pagamento}/aprovar`, {}, supervisorTk)).status, 422, 'ainda não conferido');
    assert.equal((await api.post(`${base()}/aprovacoes/${pagamento}/conferir`, { comentario: 'NF conferida' }, analistaTk)).status, 204);
    // Quem lançou não aprova; analista sem alçada também não.
    assert.equal((await api.post(`${base()}/aprovacoes/${pagamento}/aprovar`, {}, analistaTk)).status, 403);
    // Supervisor aprova; o pagamento pode ser baixado.
    assert.equal((await api.post(`${base()}/aprovacoes/${pagamento}/recusar`, {}, supervisorTk)).status, 422, 'recusa exige motivo');
    assert.equal((await api.post(`${base()}/aprovacoes/${pagamento}/aprovar`, { comentario: 'ok' }, supervisorTk)).status, 204);
    const h = (await api.get(`${base()}/lancamentos/${pagamento}`)).dados.aprovacoes.map((a) => a.etapa);
    assert.deepEqual(h, ['solicitado', 'conferido', 'aprovado']);
    // Aumentar o valor de um pagamento aprovado volta para a conferência.
    await api.patch(`${base()}/lancamentos/${pagamento}`, { valor_centavos: 450_000 });
    assert.equal((await api.get(`${base()}/lancamentos/${pagamento}`)).dados.aprovacao, 'conferencia');
    // Alçada definida pelo administrador.
    const ana = (await api.get('/usuarios')).dados.find((u) => u.email === 'ana@bpo.payax.com.br');
    assert.equal(ana.alcada_efetiva_centavos, 0);
    await api.patch(`/usuarios/${ana.id}`, { alcada_aprovacao_centavos: 1_000_000 });
    assert.equal((await api.get('/usuarios')).dados.find((u) => u.id === ana.id).alcada_efetiva_centavos, 1_000_000);
  });

  let portalTk;
  await t.test('Portal do Cliente: troca de senha, resumo, aprovação com limite, documentos e mensagens', async () => {
    assert.equal((await api.post('/portal/auth/login', { email: 'marta@bompreco.com.br', senha: 'errada' }, null)).status, 401);
    const l = await api.post('/portal/auth/login', { email: 'marta@bompreco.com.br', senha: t.marta.senha_provisoria }, null);
    assert.equal(l.status, 200);
    portalTk = l.dados.token;
    assert.equal(l.dados.responsavel.precisa_trocar_senha, true);
    assert.equal((await api.get('/portal/resumo', portalTk)).status, 403, 'precisa trocar a senha');
    assert.equal((await api.post('/portal/auth/senha', { senha_atual: t.marta.senha_provisoria, nova_senha: 'curta' }, portalTk)).status, 422);
    assert.equal((await api.post('/portal/auth/senha', { senha_atual: t.marta.senha_provisoria, nova_senha: 'NovaSenha2026' }, portalTk)).status, 204);
    const resumo = (await api.get('/portal/resumo', portalTk)).dados;
    assert.equal(typeof resumo.saldo_total_centavos, 'number');
    // Token do Portal não vale na API da equipe, e vice-versa.
    assert.equal((await api.get('/painel', portalTk)).status, 401);
    assert.equal((await api.get('/portal/resumo')).status, 401);

    // Conferido pela equipe → o cliente vê e aprova (dentro do limite de R$ 5.000).
    await api.post(`${base()}/aprovacoes/${pagamento}/conferir`, {}, analistaTk);
    let fila = (await api.get('/portal/aprovacoes', portalTk)).dados;
    assert.equal(fila.itens[0].id, pagamento);
    assert.equal(fila.itens[0].dentro_do_limite, true);
    const grande = (await pagar({ descricao: 'Reforma', valor_centavos: 900_000, categoria_id: cat('Outras despesas') })).dados.ids[0];
    await api.post(`${base()}/aprovacoes/${grande}/conferir`, {}, analistaTk);
    assert.equal((await api.post(`/portal/aprovacoes/${grande}/aprovar`, {}, portalTk)).status, 403, 'acima do limite');
    assert.equal((await api.post(`/portal/aprovacoes/${grande}/recusar`, { comentario: 'Não autorizado' }, portalTk)).status, 204);
    assert.equal((await api.post(`/portal/aprovacoes/${pagamento}/aprovar`, {}, portalTk)).status, 204);
    const hist = (await api.get(`${base()}/lancamentos/${pagamento}`)).dados.aprovacoes.at(-1);
    assert.equal(hist.responsavel_nome, 'Marta Lima');
    assert.equal((await api.post(`${base()}/lancamentos/${pagamento}/baixa`, { conta_bancaria_id: conta, data: dia() })).status, 200);
    fila = (await api.get('/portal/aprovacoes?status=recusada', portalTk)).dados;
    assert.equal(fila.itens[0].id, grande);

    // Documento enviado pelo cliente aparece para a equipe.
    const up = await api.enviarArquivo('/portal/documentos?nome=nota-fiscal.pdf&tipo=nota', Buffer.from('%PDF-1.4 nota'), portalTk);
    assert.equal(up.status, 201, JSON.stringify(up.dados));
    const lista = (await api.get(`${base()}/documentos`)).dados;
    assert.equal(lista[0].responsavel_nome, 'Marta Lima');

    // Conversa.
    await api.post('/portal/mensagens', { texto: 'Enviei a nota da reforma.' }, portalTk);
    assert.equal((await api.get('/painel')).dados.pendencias.find((p) => p.id === empresa).mensagens, 1);
    const conversa = (await api.get(`${base()}/mensagens`, analistaTk)).dados;
    assert.equal(conversa[0].autor, 'cliente');
    await api.post(`${base()}/mensagens`, { texto: 'Recebido, obrigado!' }, analistaTk);
    assert.equal((await api.get('/portal/resumo', portalTk)).dados.mensagens_nao_lidas, 1);
    assert.equal((await api.get('/portal/mensagens', portalTk)).dados.length, 2);
  });

  await t.test('documentos: vínculo ao lançamento, formatos aceitos, download como anexo e isolamento', async () => {
    assert.equal((await api.enviarArquivo(`${base()}/documentos?nome=script.html&tipo=outro`, Buffer.from('<script>'))).status, 422);
    const up = await api.enviarArquivo(`${base()}/documentos?nome=boleto.pdf&tipo=boleto&lancamento_id=${pagamento}`, Buffer.from('%PDF boleto'));
    assert.equal(up.status, 201);
    assert.equal((await api.get(`${base()}/lancamentos/${pagamento}`)).dados.documentos.length, 1);
    const dl = await api.get(`${base()}/documentos/${up.dados.id}/arquivo`);
    assert.equal(dl.dados, '%PDF boleto');
    assert.match(dl.headers.get('content-disposition'), /attachment/);
    assert.equal(dl.headers.get('content-type'), 'application/octet-stream');
    const outra = (await api.post('/empresas', { ...EMPRESA, razao_social: 'Outra', cnpj: '06.990.590/0001-23' })).dados.id;
    assert.equal((await api.get(`/empresas/${outra}/documentos/${up.dados.id}/arquivo`)).status, 404);
  });

  await t.test('cobrança: inadimplência por faixa, lembrete, promessa e acordo', async () => {
    const cliente = (await api.post(`${base()}/contatos`, { tipo: 'cliente', nome: 'Padaria Sol', telefone: '11988887777' })).dados.id;
    const receber = async (valor, venc) => (await api.post(`${base()}/lancamentos`, { tipo: 'receber', descricao: 'Fornecimento', valor_centavos: valor, vencimento: venc,
      competencia: dia(), categoria_id: cat('Venda de produtos'), contato_id: cliente })).dados.ids[0];
    const t1 = await receber(10_000, dia(-10));
    const t2 = await receber(20_000, dia(-45));
    await receber(5_000, dia(2));
    const p = (await api.get(`${base()}/cobranca`)).dados;
    assert.equal(p.faixas.find((f) => f.rotulo === '1-30').total_centavos >= 10_000, true);
    assert.equal(p.faixas.find((f) => f.rotulo === '31-60').total_centavos, 20_000);
    assert.equal(p.devedores.find((d) => d.contato_id === cliente).maior_atraso, 45);
    await api.patch(`${base()}/cobranca/config`, { chave_pix_cobranca: 'financeiro@bompreco.com.br' });
    const lembretes = (await api.get(`${base()}/cobranca/lembretes?dias=3`)).dados.filter((l) => l.contato_id === cliente);
    assert.equal(lembretes.length, 3);
    assert.match(lembretes[0].texto, /Chave PIX para pagamento: financeiro@bompreco\.com\.br/);
    assert.equal((await api.post(`${base()}/cobranca/registros`, { contato_id: cliente, lancamento_id: t1, canal: 'whatsapp', descricao: 'Lembrete enviado' })).status, 201);
    // Promessa ligada ao título: cumprida quando ele é pago.
    await api.post(`${base()}/cobranca/promessas`, { contato_id: cliente, lancamento_id: t1, data_prometida: dia(1), valor_centavos: 10_000 });
    await api.post(`${base()}/lancamentos/${t1}/baixa`, { conta_bancaria_id: conta, data: dia() });
    let ficha = (await api.get(`${base()}/cobranca/clientes/${cliente}`)).dados;
    assert.equal(ficha.promessas[0].status, 'cumprida');
    assert.equal(ficha.historico.length, 2);
    // Acordo: título de 45 dias renegociado em 2 parcelas com juros.
    const a = await api.post(`${base()}/cobranca/acordos`, { contato_id: cliente, lancamento_ids: [t2], valor_centavos: 21_000, parcelas: 2, primeiro_vencimento: dia(15) });
    assert.equal(a.status, 201, JSON.stringify(a.dados));
    ficha = (await api.get(`${base()}/cobranca/clientes/${cliente}`)).dados;
    assert.equal(ficha.acordos.length, 1);
    assert.equal((await api.get(`${base()}/lancamentos/${t2}`)).dados.status, 'cancelado');
    const parcelas = (await api.get(`${base()}/lancamentos?tipo=receber&status=aberto&busca=${encodeURIComponent(`Acordo #${a.dados.acordo_id}`)}`)).dados;
    assert.equal(parcelas.totais.quantidade, 2);
    assert.equal(parcelas.totais.valor_centavos, 21_000);
  });

  await t.test('orçamento × realizado', async () => {
    const ano = dia().slice(0, 4);
    const m = mes(dia());
    assert.equal((await api.req('PUT', `${base()}/orcamento`, { itens: [{ categoria_id: cat('Energia, água e internet'), mes: m, valor_centavos: 8_000 }] })).status, 204);
    const o = (await api.get(`${base()}/orcamento?ano=${ano}`)).dados;
    const energia = o.linhas.find((l) => l.nome === 'Energia, água e internet');
    const doMes = energia.valores.find((x) => x.mes === m);
    assert.equal(doMes.orcado, 8_000);
    assert.equal(doMes.realizado, 10_000);
    assert.equal(energia.variacao >= 2_000, true);
  });

  await t.test('fechamento mensal: etapas, travamento do período e reabertura', async () => {
    const m = somarMeses(dia(), -1).slice(0, 7);
    let f = (await api.get(`${base()}/fechamento?mes=${m}`)).dados;
    assert.equal(f.pode_fechar, false);
    assert.equal(f.etapas.find((e) => e.chave === 'conciliacao').verificacao.ok, false);
    // Etapa automática com pendência só fecha com justificativa.
    assert.equal((await api.post(`${base()}/fechamento/etapas`, { mes: m, etapa: 'conciliacao', concluir: true })).status, 422);
    for (const e of f.etapas) {
      const r = await api.post(`${base()}/fechamento/etapas`, { mes: m, etapa: e.chave, concluir: true, observacao: 'Sem extrato neste mês (empresa nova).' });
      assert.equal(r.status, 204, JSON.stringify(r.dados));
    }
    f = (await api.get(`${base()}/fechamento?mes=${m}`)).dados;
    assert.equal(f.pode_fechar, true);
    const fechar = await api.post(`${base()}/fechamento/fechar`, { mes: m });
    // Pode exigir fechar antes meses anteriores com lançamentos; neste teste, só há o mês anterior em diante.
    assert.equal(fechar.status, 204, JSON.stringify(fechar.dados));
    // Período travado: lançamento com competência no mês fechado é recusado.
    const r = await pagar({ descricao: 'Retroativo', valor_centavos: 1_000, competencia: `${m}-15`, vencimento: `${m}-15` });
    assert.equal(r.status, 409);
    assert.match(r.dados.erro, /já foi fechado/);
    // Reabertura: só supervisor/administrador, com motivo.
    assert.equal((await api.post(`${base()}/fechamento/reabrir`, { mes: m, motivo: 'Ajuste' }, analistaTk)).status, 403);
    assert.equal((await api.post(`${base()}/fechamento/reabrir`, { mes: m }, supervisorTk)).status, 422);
    assert.equal((await api.post(`${base()}/fechamento/reabrir`, { mes: m, motivo: 'NF recebida com atraso' }, supervisorTk)).status, 204);
    assert.equal((await pagar({ descricao: 'Retroativo', valor_centavos: 1_000, competencia: `${m}-15`, vencimento: `${m}-15` })).status, 201);
    const carteira = (await api.get(`/carteira/fechamento?mes=${m}`)).dados;
    assert.equal(carteira.empresas.find((e) => e.id === empresa).fechado, false);
  });

  await t.test('autenticação em duas etapas (equipe) e 2FA obrigatória', async () => {
    const tk = await api.login('sueli@bpo.payax.com.br', 'senha-forte-2');
    const ini = await api.post('/auth/2fa/iniciar', {}, tk);
    assert.match(ini.dados.uri, /^otpauth:\/\/totp\//);
    assert.match(ini.dados.qr_svg, /<svg/);
    assert.equal((await api.post('/auth/2fa/ativar', { codigo: '000000' }, tk)).status, 422);
    const codigo = totp.codigo(ini.dados.segredo, totp.passoAtual());
    assert.equal((await api.post('/auth/2fa/ativar', { codigo }, tk)).status, 200);
    const l = await api.post('/auth/login', { email: 'sueli@bpo.payax.com.br', senha: 'senha-forte-2' }, null);
    assert.equal(l.dados.precisa_2fa, true);
    assert.equal(l.dados.token, undefined);
    // O código já usado na ativação não vale de novo; o do próximo passo vale.
    assert.equal((await api.post('/auth/2fa/login', { desafio: l.dados.desafio, codigo }, null)).status, 401);
    const proximo = totp.codigo(ini.dados.segredo, totp.passoAtual() + 1);
    const ok = await api.post('/auth/2fa/login', { desafio: l.dados.desafio, codigo: proximo }, null);
    assert.equal(ok.status, 200, JSON.stringify(ok.dados));
    // 2FA obrigatória: quem não configurou só acessa a configuração.
    assert.equal((await api.patch('/seguranca/config', { exigir_2fa_equipe: true })).status, 204);
    const ana = await api.post('/auth/login', { email: 'ana@bpo.payax.com.br', senha: 'senha-forte-1' }, null);
    assert.equal(ana.dados.configurar_2fa, true);
    const bloqueado = await api.get('/painel', ana.dados.token);
    assert.equal(bloqueado.status, 403);
    assert.equal(bloqueado.dados.detalhes.configurar_2fa, true);
    assert.equal((await api.post('/auth/2fa/iniciar', {}, ana.dados.token)).status, 200);
    await api.patch('/seguranca/config', { exigir_2fa_equipe: false });
    const seg = (await api.get('/seguranca')).dados;
    assert.equal(seg.usuarios.find((u) => u.email === 'sueli@bpo.payax.com.br').totp_ativo, 1);
    assert.equal((await api.get('/seguranca', analistaTk)).status, 403);
  });

  await t.test('integrações: chave de API para ERP, CSV de lançamentos e exportação contábil', async () => {
    assert.equal((await api.post(`${base()}/integracoes/chaves`, { nome: 'ERP' }, analistaTk)).status, 403);
    const c = await api.post(`${base()}/integracoes/chaves`, { nome: 'ERP Omie' });
    assert.match(c.dados.chave, /^bpo_[0-9a-f]{12}_/);
    const r = await api.post('/integracao/v1/lancamentos', { tipo: 'pagar', descricao: 'NF 123', valor_centavos: 12_345, vencimento: dia(10),
      categoria: 'serviços terceirizados', contato: 'Gráfica Rápida', contato_documento: '06.990.590/0001-23' }, c.dados.chave);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    const l = (await api.get(`${base()}/lancamentos/${r.dados.ids[0]}`)).dados;
    assert.equal(l.contato_nome, 'Gráfica Rápida');
    assert.equal((await api.get('/integracao/v1/empresa', c.dados.chave)).dados.cnpj, '11222333000181');
    assert.equal((await api.get('/integracao/v1/empresa', 'bpo_000000000000_xxxxxxxxxxxxxxxxxxxxxxxx')).status, 401);
    // A chave não vale na API da equipe.
    assert.equal((await api.get('/painel', c.dados.chave)).status, 401);
    const chaves = (await api.get(`${base()}/integracoes/chaves`)).dados;
    await api.del(`${base()}/integracoes/chaves/${chaves[0].id}`);
    assert.equal((await api.get('/integracao/v1/empresa', c.dados.chave)).status, 401);

    const csv = 'tipo;descricao;valor;vencimento;competencia;categoria;contato;documento_contato;documento\n'
      + `pagar;Frete;150,00;${dia(3).split('-').reverse().join('/')};;Serviços terceirizados;Transportadora X;;CT-e 9\n`
      + `receber;Venda atacado;1.200,50;${dia(7)};;Venda de produtos;Padaria Sol;;\n`;
    const imp = await api.post(`${base()}/integracoes/lancamentos/importar`, { conteudo: csv, arquivo: 'erp.csv' });
    assert.deepEqual(imp.dados, { importados: 2 });
    const ruim = await api.post(`${base()}/integracoes/lancamentos/importar`, { conteudo: `${csv}pagar;X;10;${dia()};;Categoria inexistente;;;\n` });
    assert.equal(ruim.status, 422);
    assert.match(ruim.dados.erro, /Linha 4/);

    await api.patch(`${base()}/categorias/${cat('Aluguel e condomínio')}`, { conta_contabil: '4.1.01' });
    await api.patch(`${base()}/contas-bancarias/${conta}`, { conta_contabil: '1.1.02' });
    const ctb = (await api.get(`${base()}/integracoes/contabil?de=${dia(-30)}&ate=${dia()}`)).dados;
    assert.ok(ctb.quantidade >= 3);
    assert.ok(ctb.sem_codigo.some((x) => x.startsWith('Categoria:')));
    const arq = await api.get(`${base()}/integracoes/contabil.csv?de=${dia(-30)}&ate=${dia()}`);
    assert.match(arq.dados, /Conta débito;Conta crédito/);
  });

  await t.test('painel: falta de caixa projetada e backups', async () => {
    // Pagamento grande na semana que vem, sem dinheiro para cobrir.
    const id = (await pagar({ descricao: 'Equipamento', valor_centavos: 5_000_000, categoria_id: cat('Outras despesas'), vencimento: dia(6) })).dados.ids[0];
    await api.post(`${base()}/aprovacoes/${id}/conferir`, {}, analistaTk);
    const r = (await api.get(`${base()}/resumo`)).dados;
    assert.equal(r.alerta_caixa.falta, true);
    assert.equal(r.alerta_caixa.data <= dia(6), true);
    assert.equal(r.aprovacoes_pendentes >= 1, true);
    assert.equal((await api.get('/painel')).dados.pendencias.find((p) => p.id === empresa).falta_caixa !== null, true);
    const b = await api.post('/seguranca/backups');
    assert.equal(b.status, 201);
    assert.match(b.dados.nome, /^bpo-\d{8}-\d{6}\.db$/);
    assert.equal((await api.get('/seguranca')).dados.backups[0].nome, b.dados.nome);
    assert.equal((await api.get('/seguranca/backups/..%2Fbpo.db')).status, 404);
  });

  await t.test('registro de alterações: antes e depois na auditoria', async () => {
    const aud = (await api.get(`/auditoria?empresa_id=${empresa}&acao=lancamento_alterado`)).dados.itens[0];
    const d = JSON.parse(aud.detalhes);
    assert.deepEqual(d.alteracoes.valor_centavos, [400_000, 450_000]);
  });
});
