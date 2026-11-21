'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar, png, mp4, dia, limparArquivos } = require('./helpers');

const PONTO = {
  nome: 'Padaria Pão Quente', categoria: 'padaria', cidade: 'Campinas', uf: 'SP', bairro: 'Centro',
  responsavel: 'Seu Jorge', telefone: '19988887777', publico_dia: 500, comissao_percentual: 20, documento: '11.222.333/0001-81',
  horarios: [1, 2, 3, 4, 5, 6].map((d) => ({ dia_semana: d, abre: '06:00', fecha: '20:00' })),
};

test('Mídia Indoor — da instalação da TV ao faturamento', async (t) => {
  const api = await iniciar();
  t.after(() => { api.fechar(); limparArquivos(); });
  const master = await api.login();
  let ponto, outroPonto, tela, anunciante, campanha;
  let cartaz, filme;
  let tv;

  await t.test('cadastro do ponto e do anunciante', async () => {
    assert.equal((await api.post('/painel/locais', { ...PONTO, documento: '11.111.111/1111-11' }, master)).status, 422, 'CNPJ inválido é recusado');
    const r = await api.post('/painel/locais', PONTO, master);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    ponto = r.dados.id;
    assert.equal(r.dados.comissao_percentual, 2000, 'comissão guardada em centésimos');
    outroPonto = (await api.post('/painel/locais', { nome: 'Academia Força', categoria: 'academia', cidade: 'Campinas', uf: 'SP', publico_dia: 300 }, master)).dados.id;

    const det = (await api.get(`/painel/locais/${ponto}`, master)).dados;
    assert.equal(det.horarios.length, 6);
    assert.equal(det.telas.length, 0);

    const a = await api.post('/painel/anunciantes', { nome: 'Ótica Visão', documento: '11.222.333/0001-81', email: 'contato@oticavisao.com.br', telefone: '1933224455' }, master);
    assert.equal(a.status, 201, JSON.stringify(a.dados));
    anunciante = a.dados.id;
  });

  await t.test('a TV mostra um código e a equipe pareia no painel', async () => {
    tv = api.aparelho();
    const reg = await tv.registrar();
    assert.equal(reg.status, 201);
    assert.match(reg.dados.codigo, /^[A-HJ-NP-Z2-9]{6}$/, 'código sem letras/números ambíguos');

    assert.equal((await tv.pareamento(reg.dados.codigo)).dados.pareado, false, 'antes de a equipe confirmar, não há token');
    assert.equal((await tv.programacao()).status, 401, 'sem token não baixa programação');

    assert.equal((await api.post('/painel/telas/parear', { codigo: 'ZZZZZZ', local_id: ponto }, master)).status, 404);
    assert.equal((await api.post('/painel/telas/parear', { codigo: reg.dados.codigo }, master)).status, 422, 'sem informar o ponto não pareia');

    const p = await api.post('/painel/telas/parear', { codigo: reg.dados.codigo, local_id: ponto, nome: 'TV do balcão' }, master);
    assert.equal(p.status, 201, JSON.stringify(p.dados));
    tela = p.dados.id;
    assert.equal(p.dados.orientacao, 'paisagem', '1920x1080 é deduzido como paisagem');

    const entrega = await tv.pareamento(reg.dados.codigo);
    assert.equal(entrega.dados.pareado, true);
    tv.usar(entrega.dados.token);
    assert.equal((await api.post('/painel/telas/parear', { codigo: reg.dados.codigo, local_id: ponto }, master)).status, 409, 'código não serve duas vezes');

    const prog = await tv.programacao();
    assert.equal(prog.status, 200);
    assert.equal(prog.dados.grade.sem_conteudo, true, 'sem campanha, a TV fica em espera');
    assert.equal(prog.dados.tela.nome, 'TV do balcão');
  });

  await t.test('o token da TV não abre o painel, e o do painel não serve na TV', async () => {
    const tokenTela = tv.token;
    assert.equal((await api.get('/painel/resumo', tokenTela)).status, 401);
    assert.equal((await api.get('/player/programacao', master)).status, 401);
  });

  await t.test('criativos: tipo e duração vêm do arquivo, e nada vai ao ar sem aprovação', async () => {
    assert.equal((await api.enviarArquivo('/painel/midias?nome=Texto&anunciante_id=' + anunciante, Buffer.from('não é imagem'), master)).status, 415);
    assert.equal((await api.enviarArquivo('/painel/midias?nome=Vazio&anunciante_id=' + anunciante, Buffer.alloc(0), master)).status, 422);
    assert.equal((await api.enviarArquivo(`/painel/midias?nome=Sem+anunciante`, png(400, 300), master)).status, 422);

    const r = await api.enviarArquivo(`/painel/midias?nome=Cartaz+promocao&anunciante_id=${anunciante}`, png(1920, 1080), master);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    cartaz = r.dados.id;
    assert.equal(r.dados.tipo, 'imagem');
    assert.equal(r.dados.largura, 1920);
    assert.equal(r.dados.orientacao, 'paisagem');
    assert.equal(r.dados.duracao_s, 12, 'imagem assume a duração padrão da plataforma');
    assert.equal(r.dados.status, 'pendente');

    const vid = await api.enviarArquivo(`/painel/midias?nome=Filme+15s&anunciante_id=${anunciante}`, mp4(15, 1920, 1080), master);
    assert.equal(vid.status, 201, JSON.stringify(vid.dados));
    filme = vid.dados.id;
    assert.equal(vid.dados.tipo, 'video');
    assert.equal(vid.dados.duracao_s, 15, 'a duração do vídeo sai do próprio arquivo');

    const recusada = await api.enviarArquivo(`/painel/midias?nome=Fora+de+padrao&anunciante_id=${anunciante}`, png(300, 200), master);
    assert.equal((await api.post(`/painel/midias/${recusada.dados.id}/aprovacao`, { decisao: 'recusar' }, master)).status, 422, 'recusa exige motivo');
    const rec = await api.post(`/painel/midias/${recusada.dados.id}/aprovacao`, { decisao: 'recusar', motivo: 'Resolução baixa para TV' }, master);
    assert.equal(rec.dados.status, 'recusada');
    assert.equal(rec.dados.motivo, 'Resolução baixa para TV');

    for (const id of [cartaz, filme]) {
      assert.equal((await api.post(`/painel/midias/${id}/aprovacao`, { decisao: 'aprovar' }, master)).dados.status, 'aprovada');
    }
  });

  await t.test('campanha: do rascunho ao ar, com alvo por categoria', async () => {
    assert.equal((await api.post('/painel/campanhas', { anunciante_id: anunciante, nome: 'Sem valor', inicio: dia(0), cobranca: 'mensal' }, master)).status, 422);
    const r = await api.post('/painel/campanhas', {
      anunciante_id: anunciante, nome: 'Óculos de sol — verão', inicio: dia(-1), fim: dia(30), cobranca: 'mensal',
      valor_centavos: 90_000, insercoes_hora: 6, prioridade: 3, dias_semana: '0123456', hora_inicio: '00:00', hora_fim: '00:00',
      criativos: [{ midia_id: cartaz }, { midia_id: filme }],
      alvos: [{ tipo: 'categoria', valor: 'padaria' }],
    }, master);
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    campanha = r.dados.id;
    assert.equal(r.dados.status, 'rascunho');
    assert.equal(r.dados.criativos.length, 2);
    assert.equal(r.dados.telas_alcancadas, 1, 'só a TV da padaria entra no alvo');

    assert.equal((await api.post(`/painel/campanhas/${campanha}/status`, { acao: 'retomar' }, master)).status, 409);
    assert.equal((await api.post(`/painel/campanhas/${campanha}/status`, { acao: 'enviar' }, master)).dados.status, 'aguardando');
    const aprovada = await api.post(`/painel/campanhas/${campanha}/status`, { acao: 'aprovar' }, master);
    assert.equal(aprovada.dados.status, 'ativa');

    const prog = await tv.programacao();
    assert.equal(prog.dados.grade.sem_conteudo, false);
    assert.equal(prog.dados.grade.itens.length, 2, 'os dois criativos entram no loop');
    assert.equal(prog.dados.grade.duracao_s, 27);
    assert.equal(prog.dados.grade.ocupacao, 100);
    assert.equal(prog.dados.grade.campanhas[0].contratado_hora, 6);
    tv.versao = prog.dados.grade.versao;
  });

  await t.test('a TV baixa o arquivo com cache e aceita download parcial (vídeo)', async () => {
    const r = await tv.midia(filme);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'video/mp4');
    assert.match(r.headers.get('cache-control'), /immutable/);
    const etag = r.headers.get('etag');
    await r.arrayBuffer();

    const cacheado = await fetch(`${api.base}/player/midia/${filme}`, { headers: { Authorization: `Bearer ${tv.token}`, 'If-None-Match': etag } });
    assert.equal(cacheado.status, 304, 'o mesmo arquivo não é baixado de novo');

    const parcial = await fetch(`${api.base}/player/midia/${filme}`, { headers: { Authorization: `Bearer ${tv.token}`, Range: 'bytes=0-99' } });
    assert.equal(parcial.status, 206);
    assert.equal((await parcial.arrayBuffer()).byteLength, 100);
  });

  await t.test('batida e prova de exibição (sem duplicar o que foi reenviado)', async () => {
    const b = await tv.batida({ grade_versao: 'versao-antiga', versao: '1.0', item_atual: 'Cartaz promocao' });
    assert.equal(b.status, 200);
    assert.equal(b.dados.recarregar, true, 'versão diferente manda a TV baixar a grade de novo');
    const b2 = await tv.batida({ grade_versao: b.dados.grade_versao });
    assert.equal(b2.dados.recarregar, false);

    const agora = Date.now();
    const lote = [
      { midia_id: cartaz, campanha_id: campanha, exibida_em: new Date(agora - 120_000).toISOString(), duracao_s: 12 },
      { midia_id: filme, campanha_id: campanha, exibida_em: new Date(agora - 100_000).toISOString(), duracao_s: 15 },
      { midia_id: cartaz, campanha_id: campanha, exibida_em: new Date(agora - 60_000).toISOString(), duracao_s: 12 },
      { midia_id: 99_999, campanha_id: campanha, exibida_em: new Date(agora).toISOString(), duracao_s: 10 },
      { midia_id: cartaz, campanha_id: campanha, exibida_em: new Date(agora + 7 * 86_400_000).toISOString(), duracao_s: 12 },
    ];
    const r = await tv.exibicoes(lote);
    assert.deepEqual({ gravadas: r.dados.gravadas, ignoradas: r.dados.ignoradas }, { gravadas: 3, ignoradas: 2 }, 'mídia inexistente e data futura são descartadas');
    const reenvio = await tv.exibicoes(lote);
    assert.equal(reenvio.dados.gravadas, 0);
    assert.equal(reenvio.dados.repetidas, 3, 'reenvio depois de ficar sem internet não duplica');

    const telaDet = (await api.get(`/painel/telas/${tela}`, master)).dados;
    assert.equal(telaDet.hoje.insercoes, 3);
    assert.equal(telaDet.hoje.insercoes_pagas, 3);
    assert.equal(telaDet.online, true);
    assert.equal(telaDet.item_atual, 'Cartaz promocao');
  });

  await t.test('relatórios: desempenho, impactos e prova de exibição em CSV', async () => {
    const camp = (await api.get(`/painel/relatorios/campanhas?de=${dia(-1)}&ate=${dia(0)}`, master)).dados;
    assert.equal(camp.itens.length, 1);
    assert.equal(camp.itens[0].insercoes, 3);
    assert.equal(camp.itens[0].segundos, 39);
    assert.equal(camp.itens[0].impactos, 500, 'ocupando todo o tempo de tela, a campanha recebe o público do dia');

    const telas = (await api.get(`/painel/relatorios/telas?de=${dia(-1)}&ate=${dia(0)}`, master)).dados;
    assert.equal(telas.itens[0].ocupacao, 100);

    const csv = await api.get(`/painel/relatorios/prova?de=${dia(-1)}&ate=${dia(0)}&csv=1`, master);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.equal(csv.dados.split('\r\n').filter(Boolean).length, 4, 'cabeçalho + três exibições');
    assert.match(csv.dados, /Ótica Visão/);
  });

  await t.test('faturamento do mês e repasse ao lojista', async () => {
    const competencia = dia(0).slice(0, 7);
    await api.put('/painel/configuracoes', { pix_chave: 'financeiro@midiaindoor.com.br', pix_nome: 'Midia Indoor', pix_cidade: 'Campinas' }, master);

    const previa = (await api.get(`/painel/faturamento?competencia=${competencia}`, master)).dados;
    assert.equal(previa.previa.length, 1);
    const itemPrevia = previa.previa[0].itens[0];
    assert.ok(itemPrevia.valor_centavos > 0 && itemPrevia.valor_centavos <= 90_000, 'mensalidade proporcional aos dias no ar');

    const g = await api.post('/painel/faturamento/gerar', { competencia }, master);
    assert.equal(g.status, 201);
    assert.equal(g.dados.geradas, 1);
    assert.equal(g.dados.repasses, 1);

    const faturas = (await api.get('/painel/faturas', master)).dados;
    assert.equal(faturas.itens.length, 1);
    const fatura = (await api.get(`/painel/faturas/${faturas.itens[0].id}`, master)).dados;
    assert.equal(fatura.itens.length, 1);
    assert.ok(fatura.pix.codigo.startsWith('000201'), 'fatura sai com PIX copia e cola');
    assert.match(fatura.pix.qr, /^data:image\/png;base64,/);

    const repasses = (await api.get('/painel/repasses', master)).dados;
    assert.equal(repasses.itens.length, 1);
    assert.equal(repasses.itens[0].comissao_percentual, 2000);
    assert.equal(repasses.itens[0].valor_centavos, Math.round((repasses.itens[0].base_centavos * 2000) / 10_000));
    assert.equal(repasses.itens[0].base_centavos, fatura.valor_centavos, 'toda a receita veio das telas deste ponto');

    assert.equal((await api.post(`/painel/faturas/${fatura.id}/pagar`, { pago_em: dia(0) }, master)).dados.status, 'paga');
    assert.equal((await api.post(`/painel/faturas/${fatura.id}/pagar`, {}, master)).status, 409);
    assert.equal((await api.post(`/painel/repasses/${repasses.itens[0].id}/pagar`, {}, master)).dados.status, 'pago');

    // Fechar de novo não mexe no que já foi pago.
    const refeito = await api.post('/painel/faturamento/gerar', { competencia }, master);
    assert.equal(refeito.dados.mantidas, 1);
    assert.equal(refeito.dados.geradas, 0);
  });

  await t.test('portal do anunciante: só os próprios dados', async () => {
    const acesso = await api.post(`/painel/anunciantes/${anunciante}/acesso`, { nome: 'Marcos da Ótica', email: 'marcos@oticavisao.com.br' }, master);
    assert.equal(acesso.status, 201);
    assert.match(acesso.dados.senha_provisoria, /^[A-Za-z2-9]{10}$/);
    const tk = await api.login('marcos@oticavisao.com.br', acesso.dados.senha_provisoria);

    const resumo = (await api.get('/anunciante/resumo', tk)).dados;
    assert.equal(resumo.anunciante.nome, 'Ótica Visão');
    assert.equal(resumo.mes.insercoes, 3);
    assert.equal(resumo.campanhas.ativas, 1);

    const minha = (await api.get(`/anunciante/campanhas/${campanha}`, tk)).dados;
    assert.equal(minha.pontos[0].local, 'Padaria Pão Quente');
    assert.equal((await api.get('/anunciante/prova?limite=10', tk)).dados.total, 3);
    assert.equal((await api.get('/painel/resumo', tk)).status, 403, 'anunciante não entra no painel da equipe');

    const outro = (await api.post('/painel/anunciantes', { nome: 'Pizzaria Forno' }, master)).dados.id;
    const camp2 = (await api.post('/painel/campanhas', { anunciante_id: outro, nome: 'Pizza na brasa', inicio: dia(0), cobranca: 'cortesia' }, master)).dados.id;
    assert.equal((await api.get(`/anunciante/campanhas/${camp2}`, tk)).status, 404, 'não vê campanha de outro anunciante');

    const envio = await api.enviarArquivo('/anunciante/midias?nome=Novo+cartaz', png(1920, 1080), tk);
    assert.equal(envio.status, 201);
    assert.equal(envio.dados.status, 'pendente', 'o que o anunciante manda passa pela aprovação da equipe');
  });

  await t.test('portal do lojista: estado da TV, aviso na faixa e repasse', async () => {
    const acesso = await api.post(`/painel/locais/${ponto}/acesso`, { nome: 'Seu Jorge', email: 'jorge@paoquente.com.br' }, master);
    t.senhaLojista = acesso.dados.senha_provisoria;
    const tk = await api.login('jorge@paoquente.com.br', t.senhaLojista);

    const resumo = (await api.get('/ponto/resumo', tk)).dados;
    assert.equal(resumo.ponto.nome, 'Padaria Pão Quente');
    assert.equal(resumo.telas.length, 1);
    assert.equal(resumo.telas[0].online, true);
    assert.equal(resumo.hoje.insercoes, 3);
    assert.equal(resumo.repasses.length, 1);

    const prog = (await api.get(`/ponto/telas/${tela}/programacao`, tk)).dados;
    assert.equal(prog.itens.length, 2);
    assert.ok(prog.itens.every((i) => i.publicidade === true));
    assert.ok(!('anunciante' in prog.itens[0]), 'o lojista não vê de quem é cada anúncio');

    const versaoAntes = (await tv.programacao()).dados.grade.versao;
    assert.equal((await api.put(`/ponto/telas/${tela}/aviso`, { aviso: 'Pão quentinho às 17h', horas: 6 }, tk)).status, 200);
    const depois = await tv.programacao();
    assert.equal(depois.dados.tela.aviso, 'Pão quentinho às 17h');
    assert.notEqual(depois.dados.grade.versao, versaoAntes, 'mudar o aviso muda a versão da grade');

    const telaDoOutro = (await api.post('/painel/telas', { local_id: outroPonto, nome: 'TV Academia' }, master)).dados.id;
    assert.equal((await api.get(`/ponto/telas/${telaDoOutro}/programacao`, tk)).status, 404);
    assert.equal((await api.get('/painel/telas', tk)).status, 403);
  });

  await t.test('campanha que ainda vai começar abre sem erro (desempenho zerado)', async () => {
    const futura = await api.post('/painel/campanhas', {
      anunciante_id: anunciante, nome: 'Volta às aulas', inicio: dia(10), fim: dia(40), cobranca: 'mensal', valor_centavos: 50_000,
      criativos: [{ midia_id: cartaz }],
    }, master);
    assert.equal(futura.status, 201, JSON.stringify(futura.dados));
    const d = await api.get(`/painel/campanhas/${futura.dados.id}`, master);
    assert.equal(d.status, 200, JSON.stringify(d.dados));
    assert.equal(d.dados.desempenho.insercoes, 0);
    assert.deepEqual(d.dados.por_dia, []);
  });

  await t.test('lojista manda conteúdo da loja e vê a prévia', async () => {
    const tk = await api.login('jorge@paoquente.com.br', t.senhaLojista);
    const envio = await api.enviarArquivo('/ponto/midias?nome=Cartaz+da+padaria&duracao_s=10', png(1920, 1080), tk);
    assert.equal(envio.status, 201, JSON.stringify(envio.dados));
    assert.equal(envio.dados.status, 'pendente');
    assert.equal(envio.dados.uso, 'institucional');

    const arquivo = await fetch(`${api.base}/ponto/midias/${envio.dados.id}/arquivo`, { headers: { Authorization: `Bearer ${tk}` } });
    assert.equal(arquivo.status, 200);
    assert.equal(arquivo.headers.get('content-type'), 'image/png');

    const deOutro = (await api.enviarArquivo(`/painel/midias?nome=De+outro+ponto&uso=institucional&local_id=${outroPonto}`, png(800, 600), master)).dados;
    const espiar = await fetch(`${api.base}/ponto/midias/${deOutro.id}/arquivo`, { headers: { Authorization: `Bearer ${tk}` } });
    assert.equal(espiar.status, 404, 'o lojista não abre conteúdo de outro ponto');
  });

  await t.test('operador opera, mas não mexe em usuários nem nas configurações', async () => {
    await api.post('/painel/usuarios', { nome: 'Carla', email: 'carla@midia.com.br', senha: 'senha-da-carla', perfil: 'operador' }, master);
    const op = await api.login('carla@midia.com.br', 'senha-da-carla');
    assert.equal((await api.get('/painel/resumo', op)).status, 200);
    assert.equal((await api.post('/painel/anunciantes', { nome: 'Loja Nova' }, op)).status, 201);
    assert.equal((await api.get('/painel/usuarios', op)).status, 403);
    assert.equal((await api.put('/painel/configuracoes', { duracao_imagem_s: 20 }, op)).status, 403);
    assert.equal((await api.del(`/painel/anunciantes/1`, undefined, op)).status, 403);
  });

  await t.test('desparear tira o aparelho do ar; pausar a campanha esvazia a grade', async () => {
    assert.equal((await api.post(`/painel/campanhas/${campanha}/status`, { acao: 'pausar', motivo: 'Fim do estoque' }, master)).dados.status, 'pausada');
    assert.equal((await tv.programacao()).dados.grade.sem_conteudo, true, 'campanha pausada sai da TV na hora');

    assert.equal((await api.post(`/painel/telas/${tela}/desparear`, {}, master)).status, 204);
    assert.equal((await tv.programacao()).status, 401, 'o token do aparelho despareado não vale mais');
    assert.equal((await tv.exibicoes([])).status, 401);
  });

  await t.test('histórico guarda quem fez o quê', async () => {
    const a = (await api.get('/painel/auditoria?limite=200', master)).dados.itens.map((x) => x.acao);
    for (const acao of ['local_criado', 'tela_pareada', 'midia_aprovada', 'campanha_criada', 'faturamento_gerado', 'fatura_paga', 'tela_despareada']) {
      assert.ok(a.includes(acao), `falta ${acao} na auditoria`);
    }
  });
});
