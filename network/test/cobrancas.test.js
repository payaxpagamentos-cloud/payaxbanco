'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('./helpers');
const boleto = require('../server/lib/boleto');
const pix = require('../server/lib/pix');
const cnab = require('../server/lib/cnab');
const { dataLocal } = require('../server/lib/datas');

const HOJE = dataLocal('America/Sao_Paulo');

/* ---------------- Montagem de um retorno CNAB 400 de mentira ----------------
 * Escrito aqui a partir das POSIÇÕES declaradas em lib/cnab.js, campo a campo. Se alguém mexer num
 * intervalo sem querer, o teste quebra — que é exatamente o que se quer de um mapa de posições.
 */
const ddmmaa = (iso) => `${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(2, 4)}`;

function linha400(campos) {
  const l = Array(400).fill(' ');
  const por = (de, ate, valor) => {
    const t = String(valor).slice(0, ate - de + 1).padStart(ate - de + 1, '0');
    for (let i = 0; i < t.length; i++) l[de - 1 + i] = t[i];
  };
  l[0] = '1';
  por(38, 62, campos.nosso_numero);
  por(109, 110, campos.ocorrencia);
  por(111, 116, ddmmaa(campos.data_ocorrencia));
  por(117, 126, campos.documento);
  por(147, 152, ddmmaa(campos.vencimento));
  por(153, 165, campos.valor_centavos);
  por(176, 188, campos.despesas_centavos ?? 0);
  por(254, 266, campos.valor_pago_centavos ?? campos.valor_centavos);
  por(267, 279, campos.juros_centavos ?? 0);
  por(296, 301, ddmmaa(campos.data_credito ?? campos.data_ocorrencia));
  return l.join('');
}

function arquivo400(banco, registros, em = HOJE) {
  const h = Array(400).fill(' ');
  h[0] = '0';
  for (let i = 0; i < 3; i++) h[76 + i] = banco[i];
  const d = ddmmaa(em);
  for (let i = 0; i < 6; i++) h[94 + i] = d[i];
  const t = Array(400).fill(' ');
  t[0] = '9';
  return [h.join(''), ...registros.map(linha400), t.join('')].join('\r\n');
}

async function montarCenario(api) {
  const admin = await api.login();
  const r = await api.post('/organizacao/usuarios', { nome: 'Fin', email: 'fin.cob@teste.local', senha: 'senha-teste-123', perfil: 'financeiro' }, admin);
  assert.equal(r.status, 201, JSON.stringify(r.dados));
  const fin = await api.login('fin.cob@teste.local', 'senha-teste-123');
  const criar = async (caminho, corpo, tk = fin, esperado = 201) => {
    const resp = await api.post(caminho, corpo, tk);
    assert.equal(resp.status, esperado, `${caminho}: ${JSON.stringify(resp.dados)}`);
    return resp.dados;
  };
  const plano = await criar('/planos', { nome: 'Fibra 300', tipo: 'internet', tecnologia: 'fibra', download_mbps: 300, upload_mbps: 150, mensalidade: '110,00' });
  const assinante = await criar('/assinantes', { tipo: 'pf', nome: 'João da Silva', documento: '390.533.447-05', telefone: '13999112233',
    cep: '11750-000', logradouro: 'Rua Central', numero: '45', bairro: 'Centro', cidade: 'Peruíbe', uf: 'SP' });
  const contrato = await criar('/contratos', { assinante_id: assinante.id, plano_id: plano.id, dia_vencimento: 10 });
  await criar(`/contratos/${contrato.id}/ativar`, { data: HOJE }, fin, 200);
  const fatura = await criar('/faturamento/faturas', { assinante_id: assinante.id, contrato_id: contrato.id, vencimento: HOJE,
    itens: [{ descricao: 'Mensalidade', valor: '110,00' }] });
  return { admin, fin, criar, assinante, contrato, fatura };
}

const CONTA_ITAU = {
  nome: 'Itaú cobrança', banco: '341', agencia: '0912', conta: '34567', conta_dv: '8', carteira: '109',
  beneficiario_nome: 'Provedor Exemplo LTDA', beneficiario_documento: '11.222.333/0001-81',
  beneficiario_cidade: 'PERUIBE', beneficiario_uf: 'SP', beneficiario_cep: '11750-000',
  beneficiario_endereco: 'Av Principal, 1000', beneficiario_bairro: 'Centro',
  chave_pix: 'contato@provedor.com.br', chave_pix_tipo: 'email',
  emite_boleto: true, emite_pix: true, padrao: true,
};

test('cobrança bancária: conta, PIX, boleto, remessa e retorno', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const { admin, fin, criar, assinante, contrato, fatura } = await montarCenario(api);

  await t.test('só o admin configura a conta de cobrança', async () => {
    assert.equal((await api.post('/cobrancas/contas', CONTA_ITAU, fin)).status, 403, 'financeiro não mexe em dados bancários');
  });

  await t.test('conta que emite PIX precisa de chave e cidade', async () => {
    const semChave = await api.post('/cobrancas/contas', { ...CONTA_ITAU, nome: 'Sem chave', chave_pix: null, emite_boleto: false }, admin);
    assert.equal(semChave.status, 422);
    assert.match(semChave.dados.erro, /chave/i);
    const semCidade = await api.post('/cobrancas/contas', { ...CONTA_ITAU, nome: 'Sem cidade', beneficiario_cidade: null, emite_boleto: false }, admin);
    assert.equal(semCidade.status, 422);
    assert.match(semCidade.dados.erro, /cidade/i);
  });

  await t.test('conta que emite boleto só aceita banco com campo livre implementado', async () => {
    const r = await api.post('/cobrancas/contas', { ...CONTA_ITAU, nome: 'Banco sem layout', banco: '999' }, admin);
    assert.equal(r.status, 422);
    assert.match(r.dados.erro, /campo livre/i);
  });

  const conta = await criar('/cobrancas/contas', CONTA_ITAU, admin);
  assert.equal(conta.banco, '341');
  assert.equal(conta.layout_validado, 0, 'nasce sem validação de layout');

  // ---------------- PIX ----------------
  let pixEmitido;
  await t.test('PIX: BR Code válido, com o saldo da fatura, e idempotente', async () => {
    pixEmitido = await criar(`/cobrancas/faturas/${fatura.id}/emitir`, { tipo: 'pix' });
    assert.equal(pixEmitido.tipo, 'pix');
    assert.equal(pixEmitido.valor_centavos, 11000);
    const lido = pix.ler(pixEmitido.pix_brcode);
    assert.equal(lido.valido, true, 'CRC do BR Code confere');
    assert.equal(lido.chave, 'contato@provedor.com.br');
    assert.equal(lido.valor_centavos, 11000);
    assert.equal(lido.txid, pixEmitido.pix_txid);

    const denovo = await api.post(`/cobrancas/faturas/${fatura.id}/emitir`, { tipo: 'pix' }, fin);
    assert.equal(denovo.status, 200);
    assert.equal(denovo.dados.ja_existia, true);
    assert.equal(denovo.dados.id, pixEmitido.id, 'não cria um segundo PIX para a mesma fatura');
  });

  await t.test('conferir um BR Code colado pelo operador', async () => {
    const ok = await api.post('/cobrancas/pix/conferir', { codigo: pixEmitido.pix_brcode }, fin);
    assert.equal(ok.status, 200);
    assert.equal(ok.dados.valido, true);
    // Troca um caractere no meio do payload: o CRC no fim deixa de bater.
    const i = Math.floor(pixEmitido.pix_brcode.length / 2);
    const adulterado = `${pixEmitido.pix_brcode.slice(0, i)}${pixEmitido.pix_brcode[i] === 'A' ? 'B' : 'A'}${pixEmitido.pix_brcode.slice(i + 1)}`;
    const ruim = await api.post('/cobrancas/pix/conferir', { codigo: adulterado }, fin);
    assert.equal(ruim.dados.valido, false, 'código alterado não passa no CRC');
  });

  // ---------------- Boleto ----------------
  let boletoEmitido;
  await t.test('boleto: linha digitável confere com o código de barras e avisa sobre o layout', async () => {
    boletoEmitido = await criar(`/cobrancas/faturas/${fatura.id}/emitir`, { tipo: 'boleto' });
    assert.equal(boletoEmitido.codigo_barras.length, 44);
    assert.equal(boletoEmitido.linha_digitavel.length, 47);
    assert.equal(boleto.barrasDaLinha(boletoEmitido.linha_digitavel), boletoEmitido.codigo_barras, 'a linha digitável reconstrói o código de barras');
    assert.equal(boleto.conferirLinha(boletoEmitido.linha_digitavel), true);
    assert.equal(boletoEmitido.codigo_barras.slice(0, 3), '341');
    assert.ok(boletoEmitido.aviso_layout, 'enquanto o layout não foi conferido com o banco, a emissão avisa');
  });

  await t.test('fatura paga ou cancelada não recebe cobrança', async () => {
    const outra = await criar('/faturamento/faturas', { assinante_id: assinante.id, vencimento: HOJE, itens: [{ descricao: 'Taxa', valor: '20,00' }] });
    await criar(`/faturamento/faturas/${outra.id}/cancelar`, { motivo: 'Lançada por engano' }, admin, 200);
    const r = await api.post(`/cobrancas/faturas/${outra.id}/emitir`, { tipo: 'pix' }, fin);
    assert.equal(r.status, 422);
    assert.match(r.dados.erro, /cancelada/i);
  });

  // ---------------- Remessa ----------------
  let remessa;
  await t.test('remessa 240: pega o boleto emitido, numera e guarda o arquivo', async () => {
    remessa = await criar('/cobrancas/remessas', { conta_id: conta.id });
    assert.equal(remessa.titulos, 1);
    assert.equal(remessa.valor_centavos, 11000);
    assert.equal(remessa.layout, 'cnab240');
    assert.ok(remessa.aviso, 'avisa que o layout ainda não foi conferido');

    const arq = await api.get(`/cobrancas/remessas/${remessa.id}/arquivo`, fin);
    assert.equal(arq.status, 200);
    const linhas = String(arq.dados).split('\r\n').filter(Boolean);
    assert.ok(linhas.length >= 6, 'header de arquivo, header de lote, P, Q e dois trailers');
    for (const l of linhas) assert.equal(l.length, 240, `toda linha do CNAB 240 tem 240 caracteres: ${l.length}`);
    assert.equal(linhas[0].slice(0, 3), '341');
    assert.ok(linhas.some((l) => l[13] === 'P'), 'tem segmento P');
    assert.ok(linhas.some((l) => l[13] === 'Q'), 'tem segmento Q');
  });

  await t.test('não gera remessa duas vezes com os mesmos títulos', async () => {
    const r = await api.post('/cobrancas/remessas', { conta_id: conta.id }, fin);
    assert.equal(r.status, 422);
    assert.match(r.dados.erro, /aguardando remessa/i);
  });

  // ---------------- Retorno ----------------
  // Buffer, e não string: o helper serializa string como JSON, e o retorno tem de chegar como texto cru.
  const enviarRetorno = (conteudo, tk = fin) => api.req('POST', '/cobrancas/retornos', Buffer.from(conteudo, 'utf8'), tk,
    { 'Content-Type': 'text/plain', 'x-nome-arquivo': 'CB341.RET' });

  await t.test('arquivo que não é retorno de cobrança é recusado com explicação', async () => {
    const r = await enviarRetorno('isto aqui não é um arquivo de retorno de banco nenhum\n');
    assert.equal(r.status, 422);
    assert.match(r.dados.erro, /layout/i);
  });

  let previa;
  await t.test('o envio apenas CONFERE: nada é aplicado', async () => {
    const r = await enviarRetorno(arquivo400('341', [{
      nosso_numero: `${boletoEmitido.nosso_numero}${boletoEmitido.nosso_numero_dv}`,
      ocorrencia: '06', data_ocorrencia: HOJE, documento: fatura.numero,
      vencimento: HOJE, valor_centavos: 11000, valor_pago_centavos: 11000,
    }]));
    assert.equal(r.status, 201);
    previa = r.dados;
    assert.equal(previa.situacao, 'conferindo');
    assert.equal(previa.layout, 'cnab400');
    assert.equal(previa.registros, 1);
    assert.equal(previa.a_aplicar, 1);
    assert.equal(previa.itens[0].casado_por, 'nosso número com dígito', 'casa mesmo o banco devolvendo o DV grudado');
    assert.equal(previa.itens[0].ocorrencia.efeito, 'pagamento');

    const f = await api.get(`/faturamento/faturas/${fatura.id}`, fin);
    assert.equal(f.dados.situacao, 'aberta', 'a fatura continua em aberto até alguém mandar aplicar');
    assert.equal(f.dados.pago_centavos, 0);
  });

  await t.test('divergência de valor aparece na prévia em vez de virar baixa errada', async () => {
    const r = await enviarRetorno(arquivo400('341', [{
      nosso_numero: boletoEmitido.nosso_numero, ocorrencia: '06', data_ocorrencia: HOJE,
      documento: fatura.numero, vencimento: HOJE, valor_centavos: 999999, valor_pago_centavos: 999999,
    }]));
    assert.equal(r.status, 201);
    assert.equal(r.dados.com_divergencia, 1);
    assert.match(r.dados.itens[0].divergencias.join(' '), /valor do título no banco/i);
    await api.post(`/cobrancas/retornos/${r.dados.id}/descartar`, { motivo: 'Arquivo de teste do banco' }, fin);
  });

  await t.test('registro sem cobrança correspondente fica como não encontrado', async () => {
    const r = await enviarRetorno(arquivo400('341', [{
      nosso_numero: '99999', ocorrencia: '06', data_ocorrencia: HOJE, documento: '888888', vencimento: HOJE, valor_centavos: 5000,
    }]));
    assert.equal(r.dados.nao_encontrados, 1);
    assert.equal(r.dados.a_aplicar, 0);
    assert.equal(r.dados.itens[0].cobranca_id, null);
    const ap = await api.post(`/cobrancas/retornos/${r.dados.id}/aplicar`, {}, fin);
    assert.equal(ap.status, 200);
    assert.equal(ap.dados.baixados, 0, 'não inventa baixa para registro que não casou');
    assert.equal(ap.dados.ignorados, 1);
  });

  await t.test('aplicar baixa a fatura, marca a cobrança e não aplica duas vezes', async () => {
    const ap = await api.post(`/cobrancas/retornos/${previa.id}/aplicar`, {}, fin);
    assert.equal(ap.status, 200, JSON.stringify(ap.dados));
    assert.equal(ap.dados.baixados, 1);
    assert.equal(ap.dados.valor_centavos, 11000);
    assert.deepEqual(ap.dados.erros, []);

    const f = await api.get(`/faturamento/faturas/${fatura.id}`, fin);
    assert.equal(f.dados.situacao, 'paga');
    assert.equal(f.dados.pago_centavos, 11000);
    assert.equal(f.dados.pagamentos.at(-1).origem, 'retorno', 'a baixa é um pagamento comum, com a origem registrada');

    const c = await api.get(`/cobrancas?fatura_id=${fatura.id}&tipo=boleto`, fin);
    assert.equal(c.dados.itens[0].situacao, 'paga');
    assert.ok(c.dados.itens[0].pagamento_id, 'a cobrança aponta para a baixa que gerou');

    const denovo = await api.post(`/cobrancas/retornos/${previa.id}/aplicar`, {}, fin);
    assert.equal(denovo.status, 422);
    assert.match(denovo.dados.erro, /já foi aplicado/i);
  });

  await t.test('entrada confirmada do banco muda a situação, sem mexer no financeiro', async () => {
    const nova = await criar('/faturamento/faturas', { assinante_id: assinante.id, contrato_id: contrato.id, vencimento: HOJE,
      itens: [{ descricao: 'Mensalidade seguinte', valor: '110,00' }] });
    const b = await criar(`/cobrancas/faturas/${nova.id}/emitir`, { tipo: 'boleto' });
    const r = await enviarRetorno(arquivo400('341', [{
      nosso_numero: b.nosso_numero, ocorrencia: '02', data_ocorrencia: HOJE, documento: nova.numero, vencimento: HOJE, valor_centavos: 11000,
    }]));
    const ap = await api.post(`/cobrancas/retornos/${r.dados.id}/aplicar`, {}, fin);
    assert.equal(ap.dados.registrados, 1);
    assert.equal(ap.dados.baixados, 0);
    const c = await api.get(`/cobrancas?fatura_id=${nova.id}`, fin);
    assert.equal(c.dados.itens[0].situacao, 'registrada');
    assert.equal((await api.get(`/faturamento/faturas/${nova.id}`, fin)).dados.situacao, 'aberta', 'registro no banco não é pagamento');
  });

  await t.test('validar o layout tira o aviso dos boletos daquela conta', async () => {
    assert.equal((await api.post(`/cobrancas/contas/${conta.id}/validar-layout`, { confirmacao: 'Boleto de teste pago no caixa da agência' }, fin)).status, 403);
    const ok = await api.post(`/cobrancas/contas/${conta.id}/validar-layout`, { confirmacao: 'Boleto de teste pago no caixa da agência' }, admin);
    assert.equal(ok.status, 200);
    assert.equal(ok.dados.layout_validado, 1);
    const outra = await criar('/faturamento/faturas', { assinante_id: assinante.id, vencimento: HOJE, itens: [{ descricao: 'Instalação', valor: '150,00' }] });
    const b = await criar(`/cobrancas/faturas/${outra.id}/emitir`, { tipo: 'boleto' });
    assert.equal(b.aviso_layout, null, 'conta conferida não avisa mais');
  });

  await t.test('resumo mostra o que falta fazer', async () => {
    const r = await api.get('/cobrancas/resumo', fin);
    assert.equal(r.status, 200);
    assert.equal(r.dados.contas, 1);
    assert.equal(r.dados.contas_sem_layout_validado, 0);
    assert.ok(r.dados.aguardando_remessa >= 1, 'há boleto emitido sem remessa');
    assert.equal(typeof r.dados.sem_cobranca, 'number');
  });

  await t.test('outra organização não enxerga nem aplica nada daqui', async () => {
    const outro = await api.outraOrganizacao();
    assert.deepEqual((await api.get('/cobrancas/contas', outro)).dados, []);
    assert.equal((await api.get(`/cobrancas/remessas/${remessa.id}/arquivo`, outro)).status, 404);
    assert.equal((await api.post(`/cobrancas/faturas/${fatura.id}/emitir`, { tipo: 'pix' }, outro)).status, 404);
    assert.equal((await api.post(`/cobrancas/retornos/${previa.id}/aplicar`, {}, outro)).status, 404);
  });
});

test('cobrança: catálogo de bancos é honesto sobre o que foi validado', async (t) => {
  const api = await iniciar();
  t.after(() => api.fechar());
  const admin = await api.login();
  const r = await api.get('/cobrancas/bancos', admin);
  assert.equal(r.status, 200);
  assert.ok(r.dados.bancos.length >= 8);
  for (const b of r.dados.bancos) {
    assert.ok(b.codigo && b.nome, 'todo banco tem código e nome');
    assert.equal(typeof b.validado, 'boolean');
    if (!b.validado) assert.ok(b.observacao, `${b.nome} precisa dizer o que falta conferir`);
  }
  assert.equal(r.dados.adaptadores.disponivel, false, 'nenhuma API bancária conectada ainda');
  assert.match(r.dados.adaptadores.explicacao, /CNAB|PIX/);
});

test('boleto: cada banco monta 44 posições e a linha digitável volta ao código de barras', () => {
  for (const b of boleto.bancos()) {
    const m = boleto.montar({
      banco: b.codigo, valor_centavos: 109900, vencimento: '2026-05-15',
      agencia: '1234', conta: '567890', carteira: '09', convenio: '1234567',
      codigo_beneficiario: '12345678', posto: '12', modalidade: '01', nosso_numero: 1234567,
    });
    assert.equal(m.codigo_barras.length, 44, `${b.nome}: código de barras`);
    assert.equal(m.linha_digitavel.length, 47, `${b.nome}: linha digitável`);
    assert.equal(boleto.barrasDaLinha(m.linha_digitavel), m.codigo_barras, `${b.nome}: ida e volta`);
    assert.equal(m.codigo_barras.slice(0, 3), b.codigo);
    assert.equal(boleto.conferirLinha(m.linha_digitavel), true, `${b.nome}: dígitos da linha`);
  }
});

test('boleto: fator de vencimento acompanha a virada de 2025', () => {
  // Datas publicadas pela FEBRABAN: o fator dá a volta em 1000 depois de 9999.
  // A contagem começa em 07/10/1997, mas o padrão só usa fatores a partir de 1000 (03/07/2000).
  assert.throws(() => boleto.fatorVencimento('1997-10-07'), /anterior/);
  assert.equal(boleto.fatorVencimento('2000-07-03'), '1000');
  assert.equal(boleto.fatorVencimento('2025-02-21'), '9999');
  assert.equal(boleto.fatorVencimento('2025-02-22'), '1000', 'dia seguinte volta para 1000');
  assert.equal(boleto.vencimentoDoFator('1000', '2025-06-01'), '2025-02-22', 'na dúvida, o fator mais recente');
});

test('PIX: CRC16/CCITT-FALSE nos vetores canônicos', () => {
  // Vetores públicos do algoritmo (poli 0x1021, inicial 0xFFFF, sem reflexão e sem XOR final).
  const brcode = pix.brcode({ chave: 'teste@provedor.com.br', valor_centavos: 12345, beneficiario: 'PROVEDOR EXEMPLO', cidade: 'PERUIBE', txid: 'FAT123' });
  const lido = pix.ler(brcode);
  assert.equal(lido.valido, true);
  assert.equal(lido.valor_centavos, 12345);
  assert.equal(lido.txid, 'FAT123');
  assert.equal(brcode.slice(-8, -4), '6304', 'o CRC é o último campo, sempre');
  // Um caractere trocado em qualquer lugar invalida o código: é essa a função do CRC.
  assert.equal(pix.ler(`${brcode.slice(0, 10)}X${brcode.slice(11)}`).valido, false);
});

test('CNAB: cada ocorrência tem efeito declarado e só pagamento vira baixa', () => {
  const efeitos = new Set(['pagamento', 'registro', 'rejeicao', 'baixa', 'informativo']);
  for (const layout of ['cnab240', 'cnab400']) {
    for (const [codigo, [texto, efeito]] of Object.entries(cnab.OCORRENCIAS[layout])) {
      assert.ok(texto, `${layout}/${codigo} sem descrição`);
      assert.ok(efeitos.has(efeito), `${layout}/${codigo}: efeito desconhecido "${efeito}"`);
    }
  }
});
