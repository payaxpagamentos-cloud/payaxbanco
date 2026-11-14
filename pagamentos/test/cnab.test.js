'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { iniciar, CPF } = require('./helpers');
const { gerarRetorno } = require('./retorno-falso');
const cnab = require('../server/lib/cnab400');
const arquivos = require('../server/lib/arquivosBanco');
const config = require('../server/config');

const CONTA = {
  carteira: '09', agencia: '3391', conta: '0006688', conta_dv: '4',
  beneficiario_nome: 'PAY AX Brasil Ltda', beneficiario_documento: '12345678000195',
};

test('CNAB 400: o arquivo de remessa sai no formato que o banco aceita', async (t) => {
  const boleto = {
    nosso_numero: '00000000042', nosso_numero_dv: '9', seu_numero: 'FAT-1001', valor_centavos: 29990,
    emissao: '2026-11-13', vencimento: '2026-12-05', juros_mes_ppm: 10000, multa_ppm: 20000,
    desconto_centavos: 0, dias_baixa: 60, mensagem: 'Plano de internet',
    pagador_nome: 'João da Silva Ação', pagador_documento: CPF, pagador_endereco: 'Rua das Acácias',
    pagador_numero: '349', pagador_bairro: 'Centro', pagador_cidade: 'Praia Grande', pagador_uf: 'SP', pagador_cep: '11704000',
    beneficiario_final_nome: 'Connect Link Telecomunicações Ltda', beneficiario_final_documento: '11222333000181',
  };

  await t.test('todo registro tem exatamente 400 posições', () => {
    const r = cnab.gerarRemessa({ conta: CONTA, boletos: [boleto, { ...boleto, nosso_numero: '00000000043' }], sequencial: 1, hoje: '2026-11-13' });
    const linhas = r.conteudo.split('\r\n').filter(Boolean);
    assert.equal(linhas.length, 4, 'header + 2 títulos + trailer');
    for (const [i, l] of linhas.entries()) assert.equal(l.length, 400, `linha ${i + 1}`);
    assert.equal(linhas[0][0], '0');
    assert.equal(linhas[3][0], '9');
    assert.ok(r.conteudo.endsWith('\r\n'), 'arquivo termina com CRLF');
  });

  await t.test('os campos caem nas posições certas', () => {
    const l = cnab.gerarRemessa({ conta: CONTA, boletos: [boleto], sequencial: 1, hoje: '2026-11-13' })
      .conteudo.split('\r\n')[1];
    const campo = (de, ate) => l.slice(de - 1, ate);
    assert.equal(campo(1, 1), '1');
    assert.equal(campo(21, 37), '0' + '009' + '03391' + '0006688' + '4');
    assert.equal(campo(71, 81), '00000000042');
    assert.equal(campo(82, 82), '9');
    assert.equal(campo(109, 110), '01', 'ocorrência: entrada de título');
    assert.equal(campo(121, 126), '051226', 'vencimento DDMMAA');
    assert.equal(campo(127, 139), '0000000029990');
    assert.equal(campo(150, 150), 'N');
    assert.equal(campo(219, 220), '01', 'pagador pessoa física');
    assert.equal(campo(221, 234), `000${CPF}`);
    assert.equal(campo(327, 334), '11704000');
    assert.equal(campo(395, 400), '000002');
  });

  await t.test('o cliente vai registrado no banco como sacador avalista', () => {
    const l = cnab.gerarRemessa({ conta: CONTA, boletos: [boleto], sequencial: 1, hoje: '2026-11-13' })
      .conteudo.split('\r\n')[1];
    const campo = (de, ate) => l.slice(de - 1, ate);
    assert.equal(campo(335, 349), '011222333000181', 'CNPJ do cliente em 15 posições');
    assert.equal(campo(350, 351), '  ');
    assert.equal(campo(352, 394).trim(), 'CONNECT LINK TELECOMUNICACOES LTDA', 'sem acento, como o banco aceita');
    // O beneficiário continua sendo a PAY AX: o título é do convênio dela.
    assert.equal(campo(4, 17), '12345678000195');
  });

  await t.test('beneficiário final pessoa física: filial zerada no meio, como manda o manual', () => {
    const pf = { ...boleto, beneficiario_final_nome: 'Maria Souza', beneficiario_final_documento: '123.456.789-09' };
    const l = cnab.gerarRemessa({ conta: CONTA, boletos: [pf], sequencial: 1, hoje: '2026-11-13' })
      .conteudo.split('\r\n')[1];
    assert.equal(l.slice(334, 349), '123456789' + '0000' + '09');
  });

  await t.test('espécie: duplicata de serviço (12); título antigo mantém a espécie registrada', () => {
    const linha = (b) => cnab.gerarRemessa({ conta: CONTA, boletos: [b], sequencial: 1, hoje: '2026-11-13' })
      .conteudo.split('\r\n')[1].slice(147, 149);
    assert.equal(linha(boleto), '12', 'padrão: provedor vende serviço');
    assert.equal(linha({ ...boleto, especie: 'DS' }), '12');
    assert.equal(linha({ ...boleto, especie: 'DM' }), '01', 'o que já foi registrado como mercantil continua igual');
  });

  await t.test('título sem sacador avalista deixa o campo em branco (o banco aceita)', () => {
    const semBf = { ...boleto, beneficiario_final_nome: null, beneficiario_final_documento: null };
    const l = cnab.gerarRemessa({ conta: CONTA, boletos: [semBf], sequencial: 1, hoje: '2026-11-13' })
      .conteudo.split('\r\n')[1];
    assert.equal(l.slice(334, 394), ' '.repeat(60));
  });

  await t.test('acento e caractere fora da tabela não passam para o arquivo', () => {
    const l = cnab.gerarRemessa({ conta: CONTA, boletos: [boleto], sequencial: 1, hoje: '2026-11-13' })
      .conteudo.split('\r\n')[1];
    assert.equal(l.slice(234, 274).trim(), 'JOAO DA SILVA ACAO');
    assert.ok(!/[^\x20-\x7E]/.test(l), 'o registro inteiro é ASCII imprimível');
  });

  await t.test('um registro fora de 400 posições é barrado antes de sair', () => {
    assert.throws(() => cnab.gerarRemessa({ conta: { ...CONTA, beneficiario_nome: 'x'.repeat(400) }, boletos: [], sequencial: 1, hoje: '2026-11-13' }),
      /Nenhum título/);
  });

  await t.test('o nosso próprio leitor entende o que escrevemos (ida e volta)', () => {
    const retorno = gerarRetorno(CONTA, [{
      nosso_numero: '00000000042', nosso_numero_dv: '9', seu_numero: 'FAT-1001', ocorrencia: '06',
      ocorrido_em: '2026-12-05', vencimento: '2026-12-05', valor_centavos: 29990, pago_centavos: 30240,
      juros_centavos: 250, tarifa_centavos: 250, creditado_em: '2026-12-08',
    }]);
    const lido = cnab.lerRetorno(retorno);
    assert.equal(lido.registros.length, 1);
    assert.deepEqual(
      { nn: lido.registros[0].nosso_numero, acao: lido.registros[0].acao, pago: lido.registros[0].pago_centavos, credito: lido.registros[0].creditado_em },
      { nn: '00000000042', acao: 'liquidado', pago: 30240, credito: '2026-12-08' },
    );
  });

  await t.test('arquivo que não é retorno é recusado com mensagem clara', () => {
    assert.throws(() => cnab.lerRetorno('qualquer coisa'), /não parece um retorno/);
    assert.throws(() => cnab.lerRetorno(''), /vazio/);
    // Cabeçalho certo, linha curta: o erro tem que apontar o tamanho, não dizer que não é retorno.
    assert.throws(() => cnab.lerRetorno(`02RETORNO${' '.repeat(50)}`), /posições/);
  });
});

test('CNAB 400: ciclo completo — emite, manda a remessa, recebe o retorno', async (t) => {
  const api = await iniciar();
  const modoAntes = config.banco.modo;
  config.banco.modo = 'cnab';
  t.after(async () => { config.banco.modo = modoAntes; await api.fechar(); });

  const tk = await api.equipe();
  const conta = await api.conta(tk.admin);
  await api.precoPadrao(tk.admin);
  const cliente = await api.cliente(tk.admin, { retencao_dias: 0 });

  let b1; let b2; let b3;
  await t.test('no modo arquivo o título nasce aguardando a confirmação do banco', async () => {
    b1 = await api.boleto(tk.admin, cliente.cliente.id, { valor: '299,90', vencimento: '2026-12-05', seu_numero: 'FAT-1' });
    b2 = await api.boleto(tk.admin, cliente.cliente.id, { valor: '150,00', vencimento: '2026-12-06', seu_numero: 'FAT-2' });
    b3 = await api.boleto(tk.admin, cliente.cliente.id, { valor: '80,00', vencimento: '2026-12-07', seu_numero: 'FAT-3' });
    assert.equal(b1.situacao, 'registrando');
    assert.ok(b1.linha_digitavel, 'a linha digitável já sai: o pagador pode receber o boleto hoje');
    assert.equal(b1.confirmado_em, null);
  });

  let remessa;
  await t.test('a remessa leva os títulos que estavam esperando', async () => {
    const antes = (await api.get('/api/arquivos', tk.financeiro)).dados;
    assert.equal(antes.aguardando_remessa.titulos, 3);

    const r = await api.post('/api/arquivos/remessas', {}, tk.financeiro);
    assert.equal(r.status, 201);
    remessa = r.dados;
    assert.equal(remessa.titulos, 3);
    assert.ok(fs.existsSync(remessa.caminho), 'o arquivo foi escrito na pasta de saída');

    const conteudo = fs.readFileSync(remessa.caminho, 'latin1');
    assert.ok(conteudo.split('\r\n').filter(Boolean).every((l) => l.length === 400));

    const depois = (await api.get('/api/arquivos', tk.financeiro)).dados;
    assert.equal(depois.aguardando_remessa.titulos, 0, 'não vão de novo na próxima remessa');
  });

  await t.test('a mesma remessa não repete títulos', async () => {
    const r = await api.post('/api/arquivos/remessas', {}, tk.financeiro);
    assert.equal(r.status, 422);
    assert.match(r.dados.erro, /Não há títulos esperando/);
  });

  await t.test('baixar o arquivo da remessa', async () => {
    const r = await api.get(`/api/arquivos/remessas/${remessa.id}`, tk.financeiro);
    assert.equal(r.status, 200);
    assert.equal(r.dados.split('\r\n')[0].length, 400);
  });

  await t.test('o retorno confirma, liquida e rejeita, cada um com o seu efeito', async () => {
    const retorno = gerarRetorno(CONTA, [
      { nosso_numero: b1.nosso_numero, nosso_numero_dv: b1.nosso_numero_dv, ocorrencia: '02', ocorrido_em: '2026-12-01', vencimento: '2026-12-05', valor_centavos: 29990 },
      { nosso_numero: b2.nosso_numero, nosso_numero_dv: b2.nosso_numero_dv, ocorrencia: '06', ocorrido_em: '2026-12-06', vencimento: '2026-12-06', valor_centavos: 15000, pago_centavos: 15000, tarifa_centavos: 250, creditado_em: '2026-12-08' },
      { nosso_numero: b3.nosso_numero, nosso_numero_dv: b3.nosso_numero_dv, ocorrencia: '03', ocorrido_em: '2026-12-01', vencimento: '2026-12-07', valor_centavos: 8000, motivos: ['16', '45'] },
    ], { credito_em: '2026-12-08' });

    const r = await api.req('POST', '/api/arquivos/retornos', Buffer.from(retorno, 'latin1'), tk.financeiro,
      { 'Content-Type': 'application/octet-stream', 'X-Nome-Arquivo': 'CB1212.RET' });
    assert.equal(r.status, 201);
    assert.deepEqual(
      { liq: r.dados.liquidados, conf: r.dados.confirmados, rej: r.dados.rejeitados, sem: r.dados.sem_titulo },
      { liq: 1, conf: 1, rej: 1, sem: 0 },
    );

    const d1 = (await api.get(`/api/boletos/${b1.id}`, tk.admin)).dados;
    assert.equal(d1.situacao, 'registrado', 'entrada confirmada');
    assert.ok(d1.confirmado_em);

    const d2 = (await api.get(`/api/boletos/${b2.id}`, tk.admin)).dados;
    assert.equal(d2.situacao, 'liquidado');
    assert.equal(d2.pago_em, '2026-12-06', 'pago no dia da ocorrência');
    assert.equal(d2.lancamentos.length, 3, 'o split entrou no registro do cliente');
    assert.ok(d2.lancamentos.every((l) => l.data_liberacao === '2026-12-08'), 'liberado no dia em que o banco creditou');

    const d3 = (await api.get(`/api/boletos/${b3.id}`, tk.admin)).dados;
    assert.equal(d3.situacao, 'falha');
    assert.match(d3.motivo_rejeicao, /Data de vencimento inválida/);
    assert.match(d3.motivo_rejeicao, /Nome do pagador não informado/);
  });

  await t.test('o mesmo arquivo duas vezes não credita em dobro', async () => {
    const retorno = gerarRetorno(CONTA, [
      { nosso_numero: b2.nosso_numero, nosso_numero_dv: b2.nosso_numero_dv, ocorrencia: '06', ocorrido_em: '2026-12-06', vencimento: '2026-12-06', valor_centavos: 15000, pago_centavos: 15000, creditado_em: '2026-12-08' },
    ], { credito_em: '2026-12-08' });
    const antes = api.db.prepare('SELECT COUNT(*) AS n FROM lancamentos').get().n;

    const um = await api.req('POST', '/api/arquivos/retornos', Buffer.from(retorno, 'latin1'), tk.financeiro, { 'X-Nome-Arquivo': 'repetido.RET' });
    const dois = await api.req('POST', '/api/arquivos/retornos', Buffer.from(retorno, 'latin1'), tk.financeiro, { 'X-Nome-Arquivo': 'repetido.RET' });
    assert.equal(dois.dados.ja_processado, true, 'o arquivo foi reconhecido pela impressão digital');
    assert.equal(um.dados.liquidados ?? 0, 0, 'o título já estava liquidado');
    assert.equal(api.db.prepare('SELECT COUNT(*) AS n FROM lancamentos').get().n, antes, 'nenhum lançamento novo');
  });

  await t.test('título que não é nosso é contado e não quebra o arquivo', async () => {
    const retorno = gerarRetorno(CONTA, [
      { nosso_numero: '99999999999', nosso_numero_dv: '0', ocorrencia: '06', ocorrido_em: '2026-12-10', vencimento: '2026-12-10', valor_centavos: 1000, pago_centavos: 1000 },
    ], { credito_em: '2026-12-10', sequencial: 9 });
    const r = await api.req('POST', '/api/arquivos/retornos', Buffer.from(retorno, 'latin1'), tk.financeiro, { 'X-Nome-Arquivo': 'orfao.RET' });
    assert.equal(r.status, 201);
    assert.equal(r.dados.sem_titulo, 1);
    assert.equal(r.dados.liquidados, 0);
  });

  await t.test('arquivo inválido é recusado e fica registrado para conferência', async () => {
    const r = await api.req('POST', '/api/arquivos/retornos', Buffer.from('isso não é um retorno'), tk.financeiro, { 'X-Nome-Arquivo': 'ruim.txt' });
    assert.equal(r.status, 422);
    assert.match(r.dados.erro, /registrado para conferência/);
    assert.ok(api.db.prepare("SELECT 1 FROM retornos WHERE nome = 'ruim.txt' AND erro IS NOT NULL").get());
  });

  await t.test('a varredura da pasta processa o que chegou e tira o arquivo da fila', async () => {
    const b4 = await api.boleto(tk.admin, cliente.cliente.id, { valor: '500,00', vencimento: '2026-12-15', seu_numero: 'FAT-4' });
    const retorno = gerarRetorno(CONTA, [
      { nosso_numero: b4.nosso_numero, nosso_numero_dv: b4.nosso_numero_dv, ocorrencia: '06', ocorrido_em: '2026-12-15', vencimento: '2026-12-15', valor_centavos: 50000, pago_centavos: 50000, creditado_em: '2026-12-16' },
    ], { credito_em: '2026-12-16', sequencial: 20 });
    fs.writeFileSync(path.join(config.cnab.pastaRetorno, 'CB1612.RET'), retorno, 'latin1');
    // Um arquivo qualquer na mesma pasta não pode atrapalhar.
    fs.writeFileSync(path.join(config.cnab.pastaRetorno, 'leiame.txt'), 'nada a ver');

    const r = await api.post('/api/arquivos/varrer', {}, tk.financeiro);
    assert.equal(r.status, 200);
    assert.equal(r.dados.arquivos, 1);
    assert.equal(r.dados.processados[0].liquidados, 1);
    assert.equal(fs.existsSync(path.join(config.cnab.pastaRetorno, 'CB1612.RET')), false, 'saiu da pasta de entrada');
    assert.ok(fs.existsSync(path.join(config.cnab.pastaProcessados, 'CB1612.RET')));
    assert.ok(fs.existsSync(path.join(config.cnab.pastaRetorno, 'leiame.txt')), 'o que não é retorno fica onde está');

    const d4 = (await api.get(`/api/boletos/${b4.id}`, tk.admin)).dados;
    assert.equal(d4.situacao, 'liquidado');
  });

  await t.test('o pedido de baixa entra na remessa seguinte como ocorrência 02', async () => {
    const baixa = await api.post(`/api/boletos/${b1.id}/baixa`, { motivo: 'cliente desistiu' }, tk.operacao);
    assert.equal(baixa.status, 200);
    assert.equal(baixa.dados.instrucao_na_proxima_remessa, true);
    assert.equal(api.db.prepare('SELECT comando_pendente FROM boletos WHERE id = ?').get(b1.id).comando_pendente, '02');

    const r = await api.post('/api/arquivos/remessas', {}, tk.financeiro);
    assert.equal(r.status, 201);
    const conteudo = fs.readFileSync(r.dados.caminho, 'latin1');
    const detalhes = conteudo.split('\r\n').filter((l) => l.startsWith('1'));
    const oBaixado = detalhes.find((l) => l.slice(70, 81) === b1.nosso_numero);
    assert.ok(oBaixado, 'o título baixado foi para a remessa');
    assert.equal(oBaixado.slice(108, 110), '02', 'ocorrência de pedido de baixa');
    assert.equal(api.db.prepare('SELECT comando_pendente FROM boletos WHERE id = ?').get(b1.id).comando_pendente, null, 'não vai de novo');
  });

  await t.test('o painel da conciliação mostra o estado da troca de arquivos', async () => {
    const d = (await api.get('/api/arquivos', tk.financeiro)).dados;
    assert.equal(d.modo, 'cnab');
    assert.ok(d.remessas.length >= 2);
    assert.ok(d.retornos.length >= 3);
    assert.ok(d.ultimo_retorno);
    assert.equal(d.retornos_na_fila, 1, 'o leiame.txt continua lá, sem ser confundido com retorno');
  });
});
