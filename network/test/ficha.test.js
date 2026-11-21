'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const fat = require('../server/lib/faturamento');
const cob = require('../server/lib/cobranca');
const { dataLocal } = require('../server/lib/datas');

const HOJE = dataLocal('America/Sao_Paulo');
const ATUAL = fat.competenciaDe(HOJE);
const ANTERIOR = fat.somarMeses(ATUAL, -1);
const RETRASADA = fat.somarMeses(ATUAL, -2);
const dia = (c, d) => `${c}-${String(d).padStart(2, '0')}`;
const ORG = 1;

/*
 * A ficha é a tela em que o atendimento vive: tudo do cliente numa resposta só, para a tela não precisar
 * voltar ao servidor ao trocar de aba. O que este teste garante é que ela traz o todo, que cada seção
 * respeita a permissão de quem pediu, e que a linha do tempo conta a história sem repetir o mesmo fato.
 */
async function cenario(api) {
  const admin = await api.login();
  const tk = { admin };
  for (const perfil of ['financeiro', 'noc', 'gestor', 'comissoes']) {
    const r = await api.post('/organizacao/usuarios', { nome: `U ${perfil}`, email: `${perfil}.ficha@teste.local`, senha: 'senha-teste-123', perfil }, admin);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    tk[perfil] = await api.login(`${perfil}.ficha@teste.local`, 'senha-teste-123');
  }
  const plano = (await api.post('/planos', { nome: 'Fibra 500', tipo: 'internet', download_mbps: 500, upload_mbps: 250, mensalidade: '109,90', instalacao: '150,00' }, tk.financeiro)).dados;
  const assinante = (await api.post('/assinantes', { tipo: 'pf', nome: 'Maria Souza', documento: '390.533.447-05', telefone: '13999887766',
    email: 'maria@exemplo.com', cidade: 'Peruíbe', uf: 'SP', bairro: 'Centro' }, tk.financeiro)).dados;
  const contrato = (await api.post('/contratos', { assinante_id: assinante.id, plano_id: plano.id, dia_vencimento: 5 }, tk.financeiro)).dados;
  await api.post(`/contratos/${contrato.id}/ativar`, { ativacao: dia(RETRASADA, 1) }, tk.financeiro);
  await api.post(`/contratos/${contrato.id}/itens`, { descricao: 'Streaming', tipo: 'sva', valor: '19,90', inicio: ANTERIOR }, tk.financeiro);
  await api.post('/cobranca/regras', { nome: 'Aviso de atraso', dias: 1, acao: 'avisar', canal: 'whatsapp', texto: 'Sua fatura venceu.' }, tk.financeiro);
  await api.post('/cobranca/regras', { nome: 'Corte por atraso', dias: 5, acao: 'bloquear' }, tk.financeiro);
  const ciclo = await api.post('/faturamento/ciclos', { competencia: ANTERIOR }, tk.financeiro);
  assert.equal(ciclo.status, 201, JSON.stringify(ciclo.dados));
  return { tk, admin, plano, assinante, contrato };
}

test('ficha do assinante: tudo numa resposta só', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const c = await cenario(api);
  const pegar = async (token = c.tk.financeiro) => {
    const r = await api.get(`/assinantes/${c.assinante.id}`, token);
    assert.equal(r.status, 200, JSON.stringify(r.dados));
    return r.dados;
  };

  await t.test('traz cadastro, contratos, financeiro, cobrança e linha do tempo de uma vez', async () => {
    const f = await pegar();
    assert.equal(f.nome, 'Maria Souza');
    for (const secao of ['resumo', 'contratos', 'financeiro', 'cobranca', 'chamados', 'linha_tempo', 'secoes_ocultas']) {
      assert.ok(secao in f, `faltou a seção ${secao}`);
    }
    assert.equal(f.contratos.length, 1);
    assert.equal(f.financeiro.faturas.length, 1);
    assert.ok(f.linha_tempo.length >= 3);
  });

  await t.test('o contrato vem com itens, posição e o serviço no equipamento junto', async () => {
    const [contrato] = (await pegar()).contratos;
    assert.equal(contrato.plano_nome, 'Fibra 500');
    assert.equal(contrato.download_mbps, 500);
    assert.equal(contrato.itens.length, 1, 'os itens fixos vêm com o contrato');
    assert.equal(contrato.itens[0].descricao, 'Streaming');
    assert.ok(contrato.posicao.saldo_centavos > 0);
    assert.equal(contrato.servico, null, 'ainda não provisionado');
    assert.ok(Array.isArray(contrato.eventos));
    assert.ok(contrato.eventos.some((e) => e.evento === 'ativado'));
  });

  await t.test('a fatura vem com itens e baixas: a tela não precisa abrir outra', async () => {
    const [fatura] = (await pegar()).financeiro.faturas;
    assert.ok(fatura.itens.length >= 1);
    assert.ok(fatura.itens.some((i) => i.origem === 'instalacao'), 'a instalação está entre os itens');
    assert.deepEqual(fatura.pagamentos, []);
    assert.ok(fatura.encargos.dias_atraso > 0);
    assert.ok(fatura.encargos.total_devido_centavos > fatura.valor_centavos, 'o devido inclui multa e juros');
  });

  await t.test('o resumo responde o que o atendimento pergunta primeiro', async () => {
    const { resumo } = await pegar();
    assert.equal(resumo.servico, 'Serviço ativo');
    assert.equal(resumo.contratos_vivos, 1);
    assert.equal(resumo.cliente_desde, dia(RETRASADA, 1));
    assert.ok(resumo.vencidas >= 1);
    assert.ok(resumo.devido_centavos > resumo.saldo_centavos);
    assert.equal(resumo.ultimo_pagamento, null);
  });

  await t.test('depois do corte, resumo e alerta mudam sem a tela buscar nada a mais', async () => {
    cob.rotinaDiaria(api.db, ORG, HOJE);
    const f = await pegar();
    assert.equal(f.resumo.servico, 'Serviço bloqueado');
    assert.equal(f.resumo.contratos_bloqueados, 1);
    assert.equal(f.contratos[0].situacao, 'bloqueado');
    assert.ok(f.contratos[0].bloqueio, 'o bloqueio em vigor vem junto do contrato');
    assert.equal(f.cobranca.bloqueios.length, 1);
    assert.ok(f.cobranca.pendentes_envio.length >= 1, 'o aviso pronto para enviar aparece na ficha');
  });

  await t.test('a linha do tempo conta a história sem repetir o mesmo fato', async () => {
    const { linha_tempo: linha } = await pegar();
    const titulos = linha.map((x) => x.titulo);
    assert.ok(titulos.some((x) => x === 'Contrato criado'));
    assert.ok(titulos.some((x) => x === 'Serviço ativado'));
    assert.ok(titulos.some((x) => /Fatura \d+ emitida/.test(x)));
    assert.ok(titulos.some((x) => x === 'Serviço bloqueado'));
    assert.ok(titulos.some((x) => /^Aviso de cobrança/.test(x)));
    // O bloqueio da régua já é evento do contrato: não entra uma segunda vez como evento da régua.
    assert.equal(titulos.filter((x) => /Corte pela régua/.test(x)).length, 0);
    // Do mais recente para o mais antigo.
    const datas = linha.map((x) => x.em);
    assert.deepEqual(datas, [...datas].sort((a, b) => b.localeCompare(a)));
    assert.ok(linha.find((x) => x.titulo === 'Serviço bloqueado').gravidade === 'alta');
  });

  await t.test('a baixa aparece na ficha na leitura seguinte', async () => {
    const fatura = (await pegar()).financeiro.faturas[0];
    const r = await api.post(`/faturamento/faturas/${fatura.id}/pagamentos`, { forma: 'pix' }, c.tk.financeiro);
    assert.equal(r.status, 201);
    const f = await pegar();
    assert.equal(f.financeiro.faturas[0].situacao, 'paga');
    assert.equal(f.financeiro.faturas[0].pagamentos.length, 1);
    assert.ok(f.resumo.ultimo_pagamento, 'o resumo mostra o último pagamento');
    assert.ok(f.financeiro.posicao.pago_12_meses_centavos > 0);
    assert.ok(f.linha_tempo.some((x) => /^Pagamento da fatura/.test(x.titulo)));
    assert.equal(f.resumo.servico, 'Serviço ativo', 'quitar religou o contrato');
  });

  await t.test('cada seção respeita a permissão de quem pediu', async () => {
    const noc = await pegar(c.tk.noc);
    assert.deepEqual(noc.secoes_ocultas, ['financeiro', 'cobranca']);
    assert.equal(noc.financeiro, null, 'o NOC não recebe faturas');
    assert.equal(noc.cobranca, null);
    assert.ok(noc.contratos.length, 'mas continua vendo o contrato');
    assert.ok(Array.isArray(noc.chamados), 'e os chamados');
    assert.equal(noc.resumo.saldo_centavos, undefined, 'o resumo não devolve dinheiro para quem não vê dinheiro');

    // O gestor operacional acompanha tudo deste cliente: contratos, dinheiro, cobrança e chamados.
    const gestor = await pegar(c.tk.gestor);
    assert.deepEqual(gestor.secoes_ocultas, []);
    assert.ok(gestor.financeiro);
    assert.ok(gestor.cobranca);
    // O financeiro não é dono de chamados técnicos: a aba Atendimentos não existe para ele.
    const financeiro = await pegar(c.tk.financeiro);
    assert.deepEqual(financeiro.secoes_ocultas, ['atendimentos']);

    assert.equal((await api.get(`/assinantes/${c.assinante.id}`, c.tk.comissoes)).status, 403, 'conferência de comissões não acessa assinante');
    const outro = await api.outraOrganizacao();
    assert.equal((await api.get(`/assinantes/${c.assinante.id}`, outro)).status, 404);
  });

  await t.test('nenhum segredo sai na ficha', async () => {
    const corpo = JSON.stringify(await pegar());
    assert.doesNotMatch(corpo, /senha_cifrada|segredo_cifrado|wifi_senha_cifrada/, 'nenhum campo cifrado vai para a tela');
  });
});

test('ficha: o serviço no equipamento vem dentro do contrato, com a divergência calculada', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const c = await cenario(api);
  const pop = (await api.post('/rede/ativos', { tipo: 'pop', codigo: 'POP-01', nome: 'POP' }, c.tk.noc)).dados;
  const eq = (await api.post('/rede/equipamentos', { tipo: 'roteador', nome: 'BRAS-01', ativo_id: pop.id, fabricante: 'MikroTik' }, c.tk.noc)).dados;
  api.db.prepare("UPDATE equipamentos SET driver = 'mikrotik_routeros', papel = 'concentrador' WHERE id = ?").run(eq.id);
  const servico = await api.put(`/provisionamento/contratos/${c.contrato.id}/servico`, { concentrador_id: eq.id, login: 'maria.souza' }, c.tk.financeiro);
  assert.equal(servico.status, 201, JSON.stringify(servico.dados));

  await t.test('o contrato da ficha traz login, desejado e divergência', async () => {
    const [contrato] = (await api.get(`/assinantes/${c.assinante.id}`, c.tk.financeiro)).dados.contratos;
    assert.ok(contrato.servico, 'o serviço vem junto do contrato, sem outra chamada');
    assert.equal(contrato.servico.login, 'maria.souza');
    assert.equal(contrato.servico.concentrador_nome, 'BRAS-01');
    assert.equal(contrato.servico.senha_definida, true);
    assert.equal(contrato.servico.senha_cifrada, undefined);
    assert.equal(contrato.servico.desejado.download_kbps, 500_000);
    assert.equal(contrato.servico.divergencias[0].campo, 'leitura', 'sem leitura, a ficha diz que não sabe');
  });
});
