'use strict';

/**
 * Dados de demonstração: uma empresa com equipe, base de conhecimento, intenções e cerca de dois meses
 * de atendimentos — resolvidos pela ZOE, transferidos, abandonados e avaliados.
 * Não roda em cima de um banco que já tem empresa cadastrada (não estraga instalação em uso).
 *
 *   npm run seed
 */

const crypto = require('node:crypto');
const config = require('./config');
const { abrir, agora, transacao } = require('./db');
const { hashSenha } = require('./lib/senha');
const empresasLib = require('./lib/empresas');

const SENHA = 'atende2026';
const DIAS = 60;

const CONHECIMENTO = [
  ['Horário de atendimento', 'Nosso atendimento humano funciona de segunda a sexta, das 8h às 18h, e no sábado das 9h às 13h. Fora desse horário eu registro o seu pedido e a equipe responde na abertura.', 'que horas vocês abrem?\nvocês atendem sábado?\nqual o horário de atendimento?\nestá aberto agora?'],
  ['Segunda via do boleto', 'A segunda via fica na área do cliente, em fibramais.com.br/cliente, no menu Faturas. Dá para copiar a linha digitável ou pagar por PIX. Se a fatura estiver vencida, o boleto novo sai com a data de hoje.', 'preciso da segunda via\nboleto vencido\nnão recebi a fatura\ncomo pago minha fatura\nmanda o boleto'],
  ['Prazo de instalação', 'A instalação acontece em até 3 dias úteis depois da aprovação do cadastro. O técnico liga antes de sair para confirmar que tem alguém no endereço.', 'quando instalam?\nprazo de instalação\nem quanto tempo vem o técnico'],
  ['Internet lenta: o que fazer antes de abrir chamado', 'Três passos resolvem a maioria dos casos: 1) desligue o roteador da tomada por 30 segundos e ligue de novo; 2) teste a velocidade ligado por cabo, não pelo Wi-Fi; 3) verifique se tem alguém baixando ou assistindo em várias telas. Se continuar lento depois disso, eu abro um chamado para o time técnico.', 'internet lenta\nestá devagar\ncaindo muito\nvelocidade baixa\nwifi ruim'],
  ['Mudança de endereço', 'A mudança de endereço custa R$ 120,00 e depende de cobertura no endereço novo. Preciso te transferir para o time comercial para conferir a cobertura e agendar.', 'vou mudar de casa\nmudança de endereço\ntransferir a internet para outro endereço'],
  ['Planos e velocidades', 'Temos três planos: 300 Mbps por R$ 99,90, 600 Mbps por R$ 129,90 e 1 Gbps por R$ 179,90. Todos com Wi-Fi 6 incluído e instalação grátis.', 'quais os planos?\nquanto custa\npreço da internet\nquero aumentar a velocidade'],
  ['Como funciona a fatura por PIX', 'Toda fatura tem um QR Code PIX na área do cliente. O pagamento por PIX é identificado em até 10 minutos e o desbloqueio, quando houver, é automático.', 'posso pagar com pix?\npix da fatura\nquanto tempo para identificar o pagamento'],
];

const INTENCOES = [
  ['Falar com o financeiro', 'financeiro\nsegunda via\n2 via\nboleto\nfatura\npagamento\nnota fiscal', 'transferir', null, 'Financeiro', 10],
  ['Suporte técnico', 'sem internet\nsem conexao\nnao funciona\nacabou a internet\nsinal vermelho\nluz vermelha', 'transferir', null, 'Suporte técnico', 8],
  ['Cancelamento', 'cancelar\ncancelamento\nquero cancelar\nencerrar contrato\nrescisao', 'transferir', null, 'Retenção', 5],
  ['Área do cliente', 'area do cliente\nsite do cliente\nportal\napp\naplicativo', 'responder', 'A área do cliente fica em fibramais.com.br/cliente. O acesso é com o seu CPF e a senha que você cadastrou na instalação.', null, 20],
];

const FILAS = [
  ['Atendimento', 'Dúvidas e pedidos gerais', 'dúvidas gerais, informações, pedidos sem time específico', '0111110', '08:00', '18:00', 1],
  ['Financeiro', 'Boletos, pagamentos e cobrança', 'boleto, fatura, pagamento, cobrança, atraso, negociação, estorno, nota fiscal', '0111110', '08:00', '18:00', 2],
  ['Suporte técnico', 'Conexão, equipamento e visita técnica', 'sem internet, internet lenta, equipamento, modem, visita técnica, mudança de cabo', '1111111', '00:00', '23:59', 3],
  ['Retenção', 'Cancelamento e negociação de permanência', 'cancelamento, rescisão, cliente insatisfeito, reclamação formal, Procon', '0111110', '09:00', '18:00', 4],
  ['Comercial', 'Planos novos, upgrade e mudança de endereço', 'novo plano, upgrade, cobertura, mudança de endereço, indicação', '0111110', '08:00', '19:00', 5],
];

const EQUIPE = [
  ['Carlos Lima', 'carlos@fibramais.com.br', 'cliente', 8],
  ['Marina Souza', 'marina@fibramais.com.br', 'atendente', 6],
  ['Rafael Pinto', 'rafael@fibramais.com.br', 'atendente', 6],
  ['Juliana Alves', 'juliana@fibramais.com.br', 'atendente', 5],
  ['Beatriz Nunes', 'bia@fibramais.com.br', 'supervisor', 5],
];

const CONTATOS = [
  ['Ana Clara Ribeiro', '5511988880001', '12345678909'], ['Bruno Teixeira', '5511988880002', '98765432100'],
  ['Carla Monteiro', '5521988880003', null], ['Diego Fernandes', '5531988880004', '45678912377'],
  ['Elisa Carvalho', '5511988880005', null], ['Fábio Moraes', '5541988880006', '32165498711'],
  ['Gabriela Lopes', '5511988880007', null], ['Henrique Dias', '5551988880008', '78912345622'],
  ['Isabela Rocha', '5511988880009', null], ['João Pedro Matos', '5511988880010', '15935725844'],
  ['Larissa Campos', '5519988880011', null], ['Marcelo Vieira', '5511988880012', '75315985266'],
];

const PERGUNTAS_RESOLVIDAS = [
  ['qual o horário de atendimento de vocês?', 'Horário de atendimento', 'Nosso atendimento humano funciona de segunda a sexta, das 8h às 18h, e no sábado das 9h às 13h. Fora desse horário eu registro o seu pedido e a equipe responde na abertura.'],
  ['oi, quais são os planos disponíveis?', 'Planos e velocidades', 'Temos três planos: 300 Mbps por R$ 99,90, 600 Mbps por R$ 129,90 e 1 Gbps por R$ 179,90. Todos com Wi-Fi 6 incluído e instalação grátis.'],
  ['dá para pagar a fatura com pix?', 'Como funciona a fatura por PIX', 'Toda fatura tem um QR Code PIX na área do cliente. O pagamento por PIX é identificado em até 10 minutos e o desbloqueio, quando houver, é automático.'],
  ['quanto tempo demora para instalar?', 'Prazo de instalação', 'A instalação acontece em até 3 dias úteis depois da aprovação do cadastro. O técnico liga antes de sair para confirmar que tem alguém no endereço.'],
  ['minha internet está lenta hoje', 'Internet lenta: o que fazer antes de abrir chamado', 'Três passos resolvem a maioria dos casos: desligue o roteador da tomada por 30 segundos, teste por cabo e veja se tem alguém baixando. Se continuar lento, eu abro um chamado para o time técnico.'],
  ['onde eu vejo minhas faturas?', 'Segunda via do boleto', 'A segunda via fica na área do cliente, em fibramais.com.br/cliente, no menu Faturas. Dá para copiar a linha digitável ou pagar por PIX.'],
];

const TRANSFERIDAS = [
  ['preciso de um desconto na fatura de outubro, está apertado esse mês', 'Financeiro', 'Pedido de desconto exige decisão humana.', 'Cliente pede desconto na fatura de outubro alegando dificuldade financeira. Não há regra de desconto na base de conhecimento.'],
  ['quero cancelar meu contrato agora', 'Retenção', 'Pedido de cancelamento: só a equipe trata.', 'Cliente quer cancelar o contrato. Não perguntei o motivo para não irritar; passo direto para a retenção.'],
  ['já é a terceira vez que cai esse mês, quero falar com um supervisor', 'Suporte técnico', 'O cliente pediu atendimento humano ("supervisor").', 'Cliente relata a terceira queda no mês e pediu um supervisor. Histórico de instabilidade: vale verificar a porta no OLT.'],
  ['vou mudar de endereço no mês que vem, como faço?', 'Comercial', 'Mudança de endereço depende de conferir cobertura.', 'Cliente vai mudar de endereço no mês que vem e quer levar a internet. Precisa conferir cobertura no endereço novo e agendar.'],
  ['a cobrança veio dobrada, isso é um absurdo', 'Financeiro', 'Cobrança em duplicidade: precisa de análise e possível estorno.', 'Cliente relata cobrança dobrada na fatura. Não consegui conferir valores: a base não tem acesso ao faturamento.'],
  ['quero falar com uma pessoa, por favor', 'Atendimento', 'O cliente pediu atendimento humano ("falar com uma pessoa").', 'Cliente pediu uma pessoa na primeira mensagem, sem dizer o assunto.'],
];

const RESPOSTAS_HUMANAS = [
  'Oi! Aqui é a Marina, do Fibra Mais. Já estou vendo isso para você.',
  'Consegui verificar aqui. Vou te explicar como fica.',
  'Pronto, resolvido! Mais alguma coisa que eu possa ajudar?',
];

const RESPOSTAS_RAPIDAS = [
  ['boleto', 'Link do boleto', 'A segunda via está em fibramais.com.br/cliente, no menu Faturas. Qualquer dúvida, me chama!'],
  ['visita', 'Agendamento de visita', 'Consegui agendar a visita técnica. O técnico liga antes de sair para confirmar que tem alguém no endereço.'],
  ['aguarde', 'Pedir um instante', 'Só um instante que eu verifico isso no sistema, pode ser?'],
  ['despedida', 'Encerramento', 'Foi um prazer te atender! Se precisar de qualquer coisa, é só mandar mensagem por aqui. Bom dia!'],
];

const sorteio = (lista) => lista[crypto.randomInt(lista.length)];
const inteiro = (min, max) => crypto.randomInt(min, max + 1);
const quando = (diasAtras, hora = inteiro(8, 19), minuto = inteiro(0, 59)) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - diasAtras);
  d.setUTCHours(hora + 3, minuto, inteiro(0, 59), 0); // +3: horário de Brasília para UTC
  return d.toISOString();
};
const somar = (iso, segundos) => new Date(Date.parse(iso) + segundos * 1000).toISOString();

function semear(db) {
  if (db.prepare("SELECT 1 FROM empresas WHERE status <> 'excluida' LIMIT 1").get()) {
    console.log('[ZOE Atende] O banco já tem empresa cadastrada: o seed não foi aplicado.');
    console.log('              Para começar do zero, apague o arquivo do banco e rode de novo.');
    return false;
  }

  transacao(db, () => {
    const empresa = empresasLib.criar(db, { nome: 'Fibra Mais', documento: '11222333000181', email: 'contato@fibramais.com.br', telefone: '1133334444', limite_atendentes: 10, limite_ia_mes: 5000 }, { comExemplos: false });

    // Filas (as duas padrão já existem; o seed troca pelo conjunto completo).
    db.prepare('UPDATE ia_config SET fila_padrao_id = NULL WHERE empresa_id = ?').run(empresa.id);
    db.prepare('DELETE FROM filas WHERE empresa_id = ?').run(empresa.id);
    const filaId = new Map();
    for (const [nome, descricao, quandoUsar, dias, abre, fecha, ordem] of FILAS) {
      filaId.set(nome, Number(db.prepare('INSERT INTO filas (empresa_id, nome, descricao, quando_usar, dias, abre, fecha, ordem, criada_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(empresa.id, nome, descricao, quandoUsar, dias, abre, fecha, ordem, agora()).lastInsertRowid));
    }

    // Equipe.
    const equipe = [];
    for (const [nome, email, perfil, maxSim] of EQUIPE) {
      const id = Number(db.prepare('INSERT INTO usuarios (nome, email, senha_hash, perfil, empresa_id, max_simultaneas, disponivel, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(nome, email, hashSenha(SENHA), perfil, empresa.id, maxSim, perfil === 'supervisor' ? 0 : 1, agora()).lastInsertRowid);
      if (perfil !== 'supervisor') {
        for (const fid of filaId.values()) db.prepare('INSERT OR IGNORE INTO fila_usuarios (fila_id, usuario_id) VALUES (?, ?)').run(fid, id);
        equipe.push({ id, nome });
      }
    }

    // ZOE com o tom da empresa.
    db.prepare(`UPDATE ia_config SET nome_assistente = 'ZOE', fila_padrao_id = ?, max_turnos = 12, pedir_csat = 1,
        saudacao = ?, regras = ?, atualizada_em = ? WHERE empresa_id = ?`)
      .run(filaId.get('Atendimento'),
        'Olá! Eu sou a ZOE, atendente virtual do Fibra Mais. Me conta o que você precisa e eu já resolvo ou chamo alguém do time. 😊',
        'Nunca prometa desconto, isenção de multa ou prazo de visita técnica: isso é sempre da equipe.\n'
        + 'Antes de abrir chamado de internet lenta, oriente os três passos da base de conhecimento.\n'
        + 'Cliente com fatura vencida há mais de 30 dias deve ir para o Financeiro.', agora(), empresa.id);

    for (const [titulo, resposta, perguntas] of CONHECIMENTO) {
      db.prepare('INSERT INTO conhecimento (empresa_id, titulo, resposta, perguntas, usos, criado_em) VALUES (?, ?, ?, ?, ?, ?)')
        .run(empresa.id, titulo, resposta, perguntas, inteiro(3, 40), agora());
    }
    for (const [nome, palavras, acao, resposta, fila, ordem] of INTENCOES) {
      db.prepare('INSERT INTO intencoes (empresa_id, nome, palavras, acao, resposta, fila_id, ordem, usos, criada_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(empresa.id, nome, palavras, acao, resposta, fila ? filaId.get(fila) : null, ordem, inteiro(2, 25), agora());
    }
    for (const [atalho, titulo, texto] of RESPOSTAS_RAPIDAS) {
      db.prepare('INSERT INTO respostas_rapidas (empresa_id, atalho, titulo, texto, usos, criada_em) VALUES (?, ?, ?, ?, ?, ?)')
        .run(empresa.id, atalho, titulo, texto, inteiro(0, 30), agora());
    }

    const numero = empresasLib.salvarNumero(db, empresa.id, {
      nome: 'Atendimento Fibra Mais', telefone: '1133334444', phone_number_id: '100000000000001',
      token: 'EAAG-token-de-exemplo-troque-pelo-seu', app_secret: 'app-secret-de-exemplo', verify_token: 'fibramais-webhook-2026',
    });

    // Contatos.
    const contatos = CONTATOS.map(([nome, telefone, documento]) => {
      const id = Number(db.prepare('INSERT INTO contatos (empresa_id, telefone, nome, nome_perfil, documento, primeiro_contato_em, ultimo_contato_em) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(empresa.id, telefone, nome, nome.split(' ')[0], documento, quando(DIAS), quando(inteiro(0, 5))).lastInsertRowid);
      return { id, nome, telefone };
    });

    // ---------- Histórico de atendimentos ----------
    let waSeq = 0;
    const proximoWa = () => `wamid.seed.${++waSeq}`;

    const novaConversa = (contato, abertaEm) => Number(db.prepare(`INSERT INTO conversas (empresa_id, contato_id, numero_id, estado, aberta_em, ultima_mensagem_em, ultima_mensagem_cliente_em, janela_expira_em)
      VALUES (?, ?, ?, 'bot', ?, ?, ?, ?)`).run(empresa.id, contato.id, numero.id, abertaEm, abertaEm, abertaEm, somar(abertaEm, 86_400)).lastInsertRowid);

    const entrada = (conversaId, texto, em) => db.prepare(`INSERT INTO mensagens (conversa_id, empresa_id, direcao, autor, tipo, texto, wa_id, status, criada_em)
      VALUES (?, ?, 'entrada', 'cliente', 'texto', ?, ?, 'recebida', ?)`).run(conversaId, empresa.id, texto, proximoWa(), em);

    // Toda resposta saiu dentro da janela de 24 h: categoria "serviço", sem custo.
    const saida = (conversaId, texto, em, autor = 'ia', usuarioId = null) => db.prepare(`INSERT INTO mensagens (conversa_id, empresa_id, direcao, autor, usuario_id, tipo, texto, wa_id, categoria, custo_milesimos, status, criada_em, enviada_em)
      VALUES (?, ?, 'saida', ?, ?, 'texto', ?, ?, 'servico', 0, 'lida', ?, ?)`).run(conversaId, empresa.id, autor, usuarioId, texto, proximoWa(), em, somar(em, 1));

    const sistema = (conversaId, texto, em, usuarioId = null) => db.prepare(`INSERT INTO mensagens (conversa_id, empresa_id, direcao, autor, usuario_id, tipo, texto, status, criada_em)
      VALUES (?, ?, 'saida', 'sistema', ?, 'sistema', ?, 'enviada', ?)`).run(conversaId, empresa.id, usuarioId, texto, em);

    const evento = (conversaId, tipo, nome, em, { detalhe = null, entradaTk = 0, saidaTk = 0, cache = 0, ms = 0 } = {}) =>
      db.prepare(`INSERT INTO ia_eventos (empresa_id, conversa_id, tipo, nome, detalhe, tokens_entrada, tokens_saida, tokens_cache, ms, criado_em)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(empresa.id, conversaId, tipo, nome, detalhe, entradaTk, saidaTk, cache, ms, em);

    const saudacao = 'Olá! Eu sou a ZOE, atendente virtual do Fibra Mais. Me conta o que você precisa e eu já resolvo ou chamo alguém do time. 😊';
    let totais = { ia: 0, humano: 0, abandono: 0, abertas: 0 };

    for (let dia = DIAS; dia >= 0; dia--) {
      // Menos movimento no fim de semana.
      const diaSemana = new Date(quando(dia)).getUTCDay();
      const volume = [0, 6].includes(diaSemana) ? inteiro(1, 3) : inteiro(4, 9);

      for (let k = 0; k < volume; k++) {
        const contato = sorteio(contatos);
        // Um contato só pode ter uma conversa aberta por vez: no histórico, todas já estão encerradas.
        const abertaEm = quando(dia);
        const sorte = crypto.randomInt(100);

        if (sorte < 62) {
          // Resolvida pela ZOE.
          const [pergunta, artigo, resposta] = sorteio(PERGUNTAS_RESOLVIDAS);
          const id = novaConversa(contato, abertaEm);
          entrada(id, pergunta, abertaEm);
          saida(id, saudacao, somar(abertaEm, 2));
          evento(id, 'ferramenta', 'buscar_conhecimento', somar(abertaEm, 3), { detalhe: artigo, ms: inteiro(90, 400) });
          saida(id, resposta, somar(abertaEm, inteiro(4, 9)));
          evento(id, 'resposta', config.ia.modelo, somar(abertaEm, 5), { entradaTk: inteiro(900, 1600), saidaTk: inteiro(60, 180), cache: inteiro(800, 1400), ms: inteiro(1200, 4200) });
          const fim = somar(abertaEm, inteiro(40, 300));
          saida(id, 'Atendimento encerrado. Se precisar de mais alguma coisa, é só mandar mensagem. Obrigado!', fim);
          evento(id, 'encerramento', 'resolvida pela IA', fim);
          sistema(id, 'A ZOE resolveu e encerrou o atendimento.', fim);
          const comCsat = crypto.randomInt(100) < 45;
          db.prepare(`UPDATE conversas SET estado = 'encerrada', resolvida_por = 'ia', assunto = ?, intencao = ?, mensagens_ia = ?,
              encerrada_em = ?, ultima_mensagem_em = ?, csat_pedido_em = ?, csat_nota = ? WHERE id = ?`)
            .run(artigo, artigo, inteiro(1, 3), fim, fim, comCsat ? fim : null, comCsat ? sorteio([5, 5, 5, 4, 4, 3]) : null, id);
          totais.ia++;
        } else if (sorte < 90) {
          // Transferida para a equipe humana.
          const [pergunta, fila, motivo, resumo] = sorteio(TRANSFERIDAS);
          const atendente = sorteio(equipe);
          const id = novaConversa(contato, abertaEm);
          entrada(id, pergunta, abertaEm);
          saida(id, saudacao, somar(abertaEm, 2));
          const transferidaEm = somar(abertaEm, inteiro(8, 60));
          evento(id, 'transferencia', fila, transferidaEm, { detalhe: motivo });
          saida(id, 'Vou te transferir para um de nossos atendentes. Só um momento, por favor.', transferidaEm);
          sistema(id, `A ZOE transferiu para a fila ${fila}: ${motivo}`, transferidaEm);
          const assumidaEm = somar(transferidaEm, inteiro(20, 900));
          sistema(id, `${atendente.nome} assumiu o atendimento.`, assumidaEm, atendente.id);
          let t = assumidaEm;
          for (const texto of RESPOSTAS_HUMANAS.slice(0, inteiro(2, 3))) {
            t = somar(t, inteiro(30, 240));
            saida(id, texto, t, 'atendente', atendente.id);
            if (crypto.randomInt(100) < 70) { t = somar(t, inteiro(20, 180)); entrada(id, sorteio(['entendi, obrigado', 'perfeito', 'e quanto fica?', 'pode ser', 'ok']), t); }
          }
          const fim = somar(t, inteiro(60, 600));
          saida(id, 'Foi um prazer te atender! Se precisar de qualquer coisa, é só mandar mensagem por aqui.', fim, 'atendente', atendente.id);
          sistema(id, `${atendente.nome} encerrou o atendimento.`, fim, atendente.id);
          const comCsat = crypto.randomInt(100) < 55;
          db.prepare(`UPDATE conversas SET estado = 'encerrada', resolvida_por = 'humano', fila_id = ?, atendente_id = ?, assunto = ?,
              motivo_transferencia = ?, resumo = ?, mensagens_ia = ?, transferida_em = ?, assumida_em = ?, primeira_resposta_humana_em = ?,
              encerrada_em = ?, ultima_mensagem_em = ?, csat_pedido_em = ?, csat_nota = ?, prioridade = ? WHERE id = ?`)
            .run(filaId.get(fila), atendente.id, motivo.replace(/\.$/, '').slice(0, 120), motivo, resumo, inteiro(1, 4),
              transferidaEm, assumidaEm, somar(assumidaEm, inteiro(20, 120)), fim, fim,
              comCsat ? fim : null, comCsat ? sorteio([5, 4, 4, 4, 3, 3, 2]) : null, crypto.randomInt(100) < 12 ? 'alta' : 'normal', id);
          totais.humano++;
        } else {
          // O cliente sumiu antes de a conversa andar.
          const id = novaConversa(contato, abertaEm);
          entrada(id, sorteio(['oi', 'bom dia', 'olá, tudo bem?', 'oi, tem alguém?']), abertaEm);
          saida(id, saudacao, somar(abertaEm, 2));
          const fim = somar(abertaEm, 10_800);
          db.prepare("UPDATE conversas SET estado = 'encerrada', resolvida_por = 'abandono', encerrada_em = ?, ultima_mensagem_em = ? WHERE id = ?").run(fim, fim, id);
          totais.abandono++;
        }
      }
    }

    // ---------- Conversas vivas, para o painel não nascer vazio ----------
    const vivos = contatos.slice(0, 5);
    // Uma com a ZOE agora.
    {
      const abertaEm = new Date(Date.now() - 4 * 60_000).toISOString();
      const id = novaConversa(vivos[0], abertaEm);
      entrada(id, 'oi, minha internet está muito lenta desde ontem à noite', abertaEm);
      saida(id, saudacao, somar(abertaEm, 2));
      saida(id, 'Antes de abrir um chamado, faz um teste para mim? Desliga o roteador da tomada por 30 segundos, liga de novo e testa por cabo. Me conta o que deu.', somar(abertaEm, 18));
      evento(id, 'ferramenta', 'buscar_conhecimento', somar(abertaEm, 10), { detalhe: 'Internet lenta: o que fazer antes de abrir chamado', ms: 180 });
      evento(id, 'resposta', config.ia.modelo, somar(abertaEm, 16), { entradaTk: 1420, saidaTk: 96, cache: 1180, ms: 2600 });
      db.prepare('UPDATE conversas SET assunto = ?, intencao = ?, mensagens_ia = 1 WHERE id = ?').run('Internet lenta', 'Suporte técnico', id);
      totais.abertas++;
    }
    // Duas esperando na fila.
    for (const [i, contato] of [vivos[1], vivos[2]].entries()) {
      const abertaEm = new Date(Date.now() - (14 + i * 9) * 60_000).toISOString();
      const [pergunta, fila, motivo, resumo] = TRANSFERIDAS[i];
      const id = novaConversa(contato, abertaEm);
      entrada(id, pergunta, abertaEm);
      saida(id, saudacao, somar(abertaEm, 2));
      const transferidaEm = somar(abertaEm, 25);
      saida(id, 'Vou te transferir para um de nossos atendentes. Só um momento, por favor.', transferidaEm);
      sistema(id, `A ZOE transferiu para a fila ${fila}: ${motivo}`, transferidaEm);
      evento(id, 'transferencia', fila, transferidaEm, { detalhe: motivo });
      db.prepare(`UPDATE conversas SET estado = 'aguardando', fila_id = ?, assunto = ?, motivo_transferencia = ?, resumo = ?,
          transferida_em = ?, mensagens_ia = 1, prioridade = ? WHERE id = ?`)
        .run(filaId.get(fila), motivo.replace(/\.$/, '').slice(0, 120), motivo, resumo, transferidaEm, i === 0 ? 'alta' : 'normal', id);
      totais.abertas++;
    }
    // Duas em atendimento humano.
    for (const [i, contato] of [vivos[3], vivos[4]].entries()) {
      const abertaEm = new Date(Date.now() - (40 + i * 20) * 60_000).toISOString();
      const [pergunta, fila, motivo, resumo] = TRANSFERIDAS[i + 2];
      const atendente = equipe[i % equipe.length];
      const id = novaConversa(contato, abertaEm);
      entrada(id, pergunta, abertaEm);
      saida(id, saudacao, somar(abertaEm, 2));
      const transferidaEm = somar(abertaEm, 30);
      sistema(id, `A ZOE transferiu para a fila ${fila}: ${motivo}`, transferidaEm);
      evento(id, 'transferencia', fila, transferidaEm, { detalhe: motivo });
      const assumidaEm = somar(transferidaEm, 120);
      sistema(id, `${atendente.nome} assumiu o atendimento.`, assumidaEm, atendente.id);
      saida(id, RESPOSTAS_HUMANAS[0], somar(assumidaEm, 40), 'atendente', atendente.id);
      entrada(id, 'obrigado, fico no aguardo', somar(assumidaEm, 300));
      db.prepare(`UPDATE conversas SET estado = 'humano', fila_id = ?, atendente_id = ?, assunto = ?, motivo_transferencia = ?, resumo = ?,
          transferida_em = ?, assumida_em = ?, primeira_resposta_humana_em = ?, mensagens_ia = 1, ultima_mensagem_cliente_em = ?, ultima_mensagem_em = ? WHERE id = ?`)
        .run(filaId.get(fila), atendente.id, motivo.replace(/\.$/, '').slice(0, 120), motivo, resumo, transferidaEm, assumidaEm,
          somar(assumidaEm, 40), somar(assumidaEm, 300), somar(assumidaEm, 300), id);
      totais.abertas++;
    }

    // Ouvidoria: casos de cancelamento, reclamação e Procon, com desfecho.
    const OUVIDORIAS = [
      ['cancelamento', 'Quer cancelar: internet caindo há 3 semanas', 'Disse que cai toda noite e já perdeu reunião de trabalho. Avaliou mudar para a concorrência.', 'resolvida', 1, 72, 'A'],
      ['cancelamento', 'Quer cancelar por preço', 'Recebeu oferta de R$ 89,90 de outro provedor pelo mesmo plano.', 'resolvida', 0, 41, 'B'],
      ['cancelamento', 'Mudança de cidade sem cobertura', 'Vai se mudar para uma cidade onde não temos cobertura.', 'resolvida', 0, 22, 'B'],
      ['reclamacao', 'Técnico não compareceu na visita agendada', 'Esperou a tarde toda em casa e ninguém apareceu nem avisou.', 'resolvida', null, 58, 'A'],
      ['reclamacao', 'Cobrança de taxa não combinada', 'Veio uma taxa de religação que o cliente diz não ter sido avisada.', 'em_tratativa', null, 47, 'B'],
      ['procon', 'Notificação do Procon sobre velocidade', 'Reclamação registrada no Procon: alega receber menos da metade da velocidade contratada.', 'aberta', null, 81, 'A'],
      ['elogio', 'Elogiou o atendimento da Marina', 'Disse que foi o melhor atendimento que já teve em provedor.', 'resolvida', null, 8, 'A'],
    ];
    for (const [i, [tipo, assunto, relato, status, retido, risco, classe]] of OUVIDORIAS.entries()) {
      const contato = contatos[i % contatos.length];
      const abertaEm = quando(inteiro(1, 25));
      const mensalidade = sorteio([9990, 12990, 17990]);
      const protocolo = `OUV-${new Date().toISOString().slice(0, 7).replace('-', '')}-${String(i + 1).padStart(4, '0')}`;
      const encerrada = ['resolvida', 'improcedente'].includes(status);
      const resolvidaEm = encerrada ? somar(abertaEm, inteiro(3600, 160_000)) : null;
      const id = Number(db.prepare(`INSERT INTO ouvidoria
          (empresa_id, protocolo, contato_id, ixc_cliente_id, tipo, origem, assunto, relato, status, prioridade, prazo_em,
           responsavel_id, risco_na_abertura, valor_na_abertura, mensalidade_centavos, desfecho, retido, valor_anual_centavos, aberta_em, assumida_em, resolvida_em)
        VALUES (?, ?, ?, ?, ?, 'ia', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(empresa.id, protocolo, contato.id, String(500 + i), tipo, assunto, relato, status,
          ['procon', 'anatel', 'cancelamento'].includes(tipo) ? 'alta' : 'normal',
          somar(abertaEm, tipo === 'procon' ? 86_400 : 172_800),
          encerrada || status === 'em_tratativa' ? sorteio(equipe).id : null,
          risco, classe, mensalidade,
          encerrada ? (retido === 1 ? 'Ofereceu-se a troca do roteador e o cliente aceitou ficar.' : retido === 0 ? 'Cliente optou por sair; contrato encerrado sem multa.' : 'Pedido de desculpas e reagendamento com prioridade.') : null,
          retido, mensalidade * 12, abertaEm, encerrada ? somar(abertaEm, 1800) : null, resolvidaEm).lastInsertRowid);
      db.prepare("INSERT INTO ouvidoria_eventos (ouvidoria_id, tipo, texto, criado_em) VALUES (?, 'abertura', ?, ?)")
        .run(id, `Caso aberto pela ZOE: ${assunto}`, abertaEm);
      db.prepare("INSERT INTO ouvidoria_eventos (ouvidoria_id, tipo, texto, criado_em) VALUES (?, 'abertura', ?, ?)")
        .run(id, `Na abertura: risco ${risco}/100 (${risco >= 60 ? 'alto' : risco >= 30 ? 'medio' : 'baixo'}), cliente classe ${classe}.`, abertaEm);
      if (resolvidaEm) {
        db.prepare("INSERT INTO ouvidoria_eventos (ouvidoria_id, usuario_id, tipo, texto, criado_em) VALUES (?, ?, 'desfecho', ?, ?)")
          .run(id, sorteio(equipe).id, retido === 1 ? 'Encerrada como resolvida — cliente RETIDO.' : retido === 0 ? 'Encerrada como resolvida — cliente PERDIDO.' : 'Encerrada como resolvida.', resolvidaEm);
      }
    }

    // ---------- Régua de cobrança e a conta da Meta ----------
    const regua = Number(db.prepare(`INSERT INTO reguas
        (empresa_id, nome, tipo, categoria, template, idioma, parametros, texto_janela, gatilho, dias, hora, dias_semana,
         preferir_janela, pular_se_conversa_aberta, pular_se_pago, repetir_apos_dias, ativa, ultima_execucao_em, criada_em)
      VALUES (?, 'Lembrete 3 dias antes', 'cobranca', 'utilidade', 'aviso_fatura', 'pt_BR', ?, ?, 'dias_antes_vencimento', 3, '09:00', '0111110', 1, 1, 1, 5, 1, ?, ?)`)
      .run(empresa.id, 'primeiro_nome\nvencimento\nvalor',
        'Oi {primeiro_nome}! Sua fatura de {valor} vence em {vencimento}. Quer que eu mande o PIX por aqui?',
        quando(1), quando(DIAS)).lastInsertRowid);
    const reguaAtraso = Number(db.prepare(`INSERT INTO reguas
        (empresa_id, nome, tipo, categoria, template, idioma, parametros, texto_janela, gatilho, dias, hora, dias_semana,
         preferir_janela, pular_se_conversa_aberta, pular_se_pago, repetir_apos_dias, ativa, ultima_execucao_em, criada_em)
      VALUES (?, 'Fatura vencida há 5 dias', 'cobranca', 'utilidade', 'fatura_vencida', 'pt_BR', ?, ?, 'dias_apos_vencimento', 5, '10:00', '0111110', 1, 1, 1, 7, 1, ?, ?)`)
      .run(empresa.id, 'primeiro_nome\ndias_atraso\nvalor',
        'Oi {primeiro_nome}, sua fatura de {valor} está em aberto. Posso mandar o PIX para você quitar agora?',
        quando(1), quando(DIAS)).lastInsertRowid);

    // Trinta dias de disparos, com as decisões que a régua toma na vida real.
    const MOTIVOS_PULO = [
      ['a fatura já foi paga', 46], ['o cliente pediu para não receber mensagens ativas', 8],
      ['o cliente já está em atendimento com a equipe', 11], ['já recebeu esta régua nos últimos 5 dias', 15],
    ];
    let disparosTotais = { enviados: 0, janela: 0, pulados: 0, custo: 0, economia: 0 };
    for (let dia = 29; dia >= 0; dia--) {
      const diaSemana = new Date(quando(dia)).getUTCDay();
      if ([0, 6].includes(diaSemana)) continue;
      for (const [id, preco] of [[regua, 35], [reguaAtraso, 35]]) {
        const alvos = inteiro(28, 52);
        for (let i = 0; i < alvos; i++) {
          const contato = sorteio(contatos);
          const sorte = crypto.randomInt(100);
          const em = quando(dia, 9, inteiro(0, 50));
          if (sorte < 26) {
            // Pulado: a régua não gastou a mensagem.
            const [motivo] = sorteio(MOTIVOS_PULO);
            db.prepare(`INSERT INTO disparos (empresa_id, regua_id, contato_id, status, motivo, custo_milesimos, economia_milesimos, criado_em)
              VALUES (?, ?, ?, 'pulado', ?, 0, ?, ?)`).run(empresa.id, id, contato.id, motivo, preco, em);
            disparosTotais.pulados++;
            disparosTotais.economia += preco;
          } else if (sorte < 44) {
            // Janela de 24 h aberta: foi como serviço, de graça.
            db.prepare(`INSERT INTO disparos (empresa_id, regua_id, contato_id, categoria, status, motivo, custo_milesimos, economia_milesimos, criado_em)
              VALUES (?, ?, ?, 'servico', 'enviado', 'a janela de 24 h está aberta: vai como serviço, sem custo', 0, ?, ?)`)
              .run(empresa.id, id, contato.id, preco, em);
            const conversaAberta = Number(db.prepare('SELECT id FROM conversas WHERE contato_id = ? ORDER BY id DESC LIMIT 1').get(contato.id)?.id ?? 0);
            if (conversaAberta) {
              db.prepare(`INSERT INTO mensagens (conversa_id, empresa_id, direcao, autor, tipo, texto, wa_id, categoria, custo_milesimos, status, criada_em, enviada_em)
                VALUES (?, ?, 'saida', 'sistema', 'texto', 'Oi! Sua fatura vence em 3 dias. Quer o PIX por aqui?', ?, 'servico', 0, 'entregue', ?, ?)`)
                .run(conversaAberta, empresa.id, proximoWa(), em, em);
            }
            disparosTotais.enviados++;
            disparosTotais.janela++;
            disparosTotais.economia += preco;
          } else {
            // Template de utilidade: aqui a Meta cobra.
            db.prepare(`INSERT INTO disparos (empresa_id, regua_id, contato_id, categoria, status, custo_milesimos, economia_milesimos, criado_em)
              VALUES (?, ?, ?, 'utilidade', 'enviado', ?, 0, ?)`).run(empresa.id, id, contato.id, preco, em);
            // A mensagem cobrada também entra no histórico, para a conta por categoria bater.
            const conversaId = Number(db.prepare('SELECT id FROM conversas WHERE contato_id = ? ORDER BY id DESC LIMIT 1').get(contato.id)?.id ?? 0);
            if (conversaId) {
              db.prepare(`INSERT INTO mensagens (conversa_id, empresa_id, direcao, autor, tipo, texto, wa_id, categoria, custo_milesimos, status, criada_em, enviada_em)
                VALUES (?, ?, 'saida', 'sistema', 'template', '[Lembrete] template aviso_fatura', ?, 'utilidade', ?, 'entregue', ?, ?)`)
                .run(conversaId, empresa.id, proximoWa(), preco, em, em);
            }
            disparosTotais.enviados++;
            disparosTotais.custo += preco;
          }
        }
      }
    }

    // ---------- Alertas de rede ----------
    // Um em vigor (a ZOE já está avisando), um agendado e um encerrado, para a tela mostrar
    // os três estados sem ninguém precisar esperar o relógio.
    const ALERTAS = [
      ['Rompimento de fibra no Centro', 'Já identificamos uma falha de fibra que afeta a sua região. A equipe técnica está no local agora.',
        'massiva', 'chave', 'Centro\nCentro Histórico', 'até as 18h de hoje', 0, -3, 6, 1, 47],
      ['Manutenção programada na OLT-07', 'Vamos fazer uma manutenção programada na sua região, e a conexão pode oscilar durante o período.',
        'manutencao', 'chave', 'OLT-07\nJardim América', 'das 2h às 5h de amanhã', 0, 20, 27, 1, 0],
      ['Queda de energia no POP Vila Nova', 'Houve uma queda de energia que afetou a sua região. O fornecimento já foi normalizado.',
        'massiva', 'chave', 'Vila Nova', null, 0, -72, -60, 1, 134],
    ];
    for (const [titulo, mensagem, tipo, abrangencia, chaves, previsao, abreChamado, deH, ateH, ativo, avisados] of ALERTAS) {
      db.prepare(`INSERT INTO alertas (empresa_id, titulo, mensagem, tipo, abrangencia, chaves, previsao, abre_chamado,
          inicio, fim, ativo, avisados, criado_por, criado_em)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Beatriz Nunes', ?)`)
        .run(empresa.id, titulo, mensagem, tipo, abrangencia, chaves, previsao, abreChamado,
          new Date(Date.now() + deH * 3_600_000).toISOString(), new Date(Date.now() + ateH * 3_600_000).toISOString(),
          ativo, avisados, quando(1));
    }

    // ---------- Orçamento, sala de espera e meses fechados ----------
    // Teto de R$ 60,00/mês: dá para a tela mostrar a barra num nível de atenção de verdade.
    db.prepare('UPDATE empresas SET orcamento_milesimos = ?, orcamento_marketing_milesimos = ? WHERE id = ?')
      .run(60_000, 10_000, empresa.id);

    // Avisos esperando a janela abrir: nada foi pago por eles ainda.
    for (let i = 0; i < 14; i++) {
      const contato = sorteio(contatos);
      const vence = somar(quando(-inteiro(1, 4)), 0).slice(0, 10);
      try {
        db.prepare(`INSERT INTO pendencias (empresa_id, regua_id, contato_id, referencia, dados, texto, prazo, status, criada_em)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'esperando', ?)`)
          .run(empresa.id, sorteio([regua, reguaAtraso]), contato.id, `fat-${900 + i}`,
            JSON.stringify({ nome: contato.nome, vencimento: vence, valor_centavos: 12990 }),
            `Sua fatura de R$ 129,90 vence em ${vence.split('-').reverse().join('/')}. Quer que eu mande o PIX por aqui?`,
            quando(-inteiro(1, 3), 9, 0), quando(inteiro(0, 2)));
      } catch { /* mesma régua e contato: a chave única já barrou */ }
    }
    // E alguns que já foram salvos pela janela, para o indicador não nascer zerado.
    for (let i = 0; i < 9; i++) {
      const contato = sorteio(contatos);
      try {
        db.prepare(`INSERT INTO pendencias (empresa_id, regua_id, contato_id, referencia, dados, texto, prazo, status, resolucao, resolvida_em, criada_em)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'entregue', 'janela', ?, ?)`)
          .run(empresa.id, regua, contato.id, `fat-salva-${i}`, '{}', 'Aviso entregue pela janela.',
            quando(5 + i), quando(6 + i), quando(8 + i));
      } catch { /* idem */ }
    }

    // Três meses fechados: um conferido e batendo, um conferido e divergente, um sem conferência.
    const MESES_FECHADOS = [
      { atras: 3, gasto: 41_300, fatura: 4130, obs: null },
      { atras: 2, gasto: 52_800, fatura: 6150, obs: 'A Meta reclassificou parte dos avisos como marketing.' },
      { atras: 1, gasto: 38_900, fatura: null, obs: null },
    ];
    for (const m of MESES_FECHADOS) {
      const d = new Date(quando(0));
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() - m.atras);
      const mes = d.toISOString().slice(0, 7);
      const utilidades = Math.round(m.gasto / 35);
      const servicos = utilidades * 4;
      const economia = Math.round(m.gasto * 1.3);
      db.prepare(`INSERT INTO custos_mensais
          (empresa_id, mes, mensagens, por_categoria, gasto_milesimos, economia_milesimos, sem_otimizacao_milesimos,
           orcamento_milesimos, fatura_meta_centavos, conferido_em, conferido_por, observacao, fechado_em)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(empresa.id, mes, utilidades + servicos, JSON.stringify([
          { categoria: 'servico', nome: 'Serviço', preco_milesimos: 0, mensagens: servicos, custo_milesimos: 0 },
          { categoria: 'utilidade', nome: 'Utilidade', preco_milesimos: 35, mensagens: utilidades, custo_milesimos: m.gasto },
          { categoria: 'autenticacao', nome: 'Autenticação', preco_milesimos: 30, mensagens: 0, custo_milesimos: 0 },
          { categoria: 'marketing', nome: 'Marketing', preco_milesimos: 320, mensagens: 0, custo_milesimos: 0 },
        ]), m.gasto, economia, m.gasto + economia, 60_000,
        m.fatura, m.fatura ? quando(m.atras * 28 - 20) : null, m.fatura ? 'Beatriz Nunes' : null, m.obs,
        quando(m.atras * 28 - 25));
    }

    // Chamados abertos pela ZOE.
    for (const [i, contato] of contatos.slice(0, 6).entries()) {
      const criadoEm = quando(inteiro(0, 20));
      db.prepare(`INSERT INTO chamados (empresa_id, contato_id, protocolo, assunto, descricao, fila_id, status, aberto_por, criado_em, atualizado_em)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'ia', ?, ?)`)
        .run(empresa.id, contato.id, `${new Date().toISOString().slice(0, 7).replace('-', '')}-${String(i + 1).padStart(5, '0')}`,
          sorteio(['Internet oscilando à noite', 'Pedido de visita técnica', 'Troca de equipamento', 'Mudança de vencimento', 'Cobrança a conferir']),
          'Relato do cliente registrado pela ZOE.', filaId.get(sorteio(['Suporte técnico', 'Financeiro'])),
          sorteio(['aberto', 'aberto', 'andamento', 'resolvido']), criadoEm, criadoEm);
    }

    console.log(`[ZOE Atende] Empresa "${empresa.nome}" criada com ${FILAS.length} filas, ${EQUIPE.length} pessoas na equipe e ${CONHECIMENTO.length} artigos na base.`);
    console.log(`             Ouvidoria: ${OUVIDORIAS.length} casos, sendo ${OUVIDORIAS.filter((o) => o[0] === 'cancelamento').length} de cancelamento.`);
    console.log(`             Régua: ${disparosTotais.enviados} enviadas (${disparosTotais.janela} pela janela, de graça) e ${disparosTotais.pulados} puladas.`);
    console.log(`             Conta da Meta no período: gasto R$ ${(disparosTotais.custo / 1000).toFixed(2)} · economia R$ ${(disparosTotais.economia / 1000).toFixed(2)}.`);
    console.log(`             Alertas de rede: ${db.prepare("SELECT COUNT(*) n FROM alertas WHERE empresa_id = ?").get(empresa.id).n} cadastrados, ${require('./lib/alertas').vigentes(db, empresa.id).length} em vigor agora.`);
    console.log(`             Orçamento: R$ 60,00/mês. Sala de espera: ${db.prepare("SELECT COUNT(*) n FROM pendencias WHERE status = 'esperando'").get().n} avisos esperando a janela.`);
    console.log(`             Fechamentos: ${db.prepare('SELECT COUNT(*) n FROM custos_mensais').get().n} meses, 1 divergente contra a fatura da Meta.`);
    console.log(`             Histórico: ${totais.ia} resolvidas pela IA, ${totais.humano} transferidas, ${totais.abandono} abandonadas e ${totais.abertas} em aberto agora.`);
  });
  return true;
}

if (require.main === module) {
  const db = abrir();
  if (semear(db)) {
    console.log('');
    console.log('Acesse o painel e entre com:');
    console.log(`  Master da plataforma: ${config.admin.email} / ${config.admin.senha}`);
    for (const [nome, email, perfil] of EQUIPE) console.log(`  ${perfil.padEnd(10)} ${email} / ${SENHA}  (${nome})`);
  }
}

module.exports = { semear, SENHA };
