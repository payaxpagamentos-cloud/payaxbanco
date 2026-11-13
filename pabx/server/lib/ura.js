'use strict';

const { agora } = require('../db');
const { ErroNegocio, naoEncontrado } = require('./erros');
const v = require('./validacao');

/**
 * A URA inteligente.
 *
 * A URA comum pergunta a mesma coisa para todo mundo: "1 para suporte, 2 para financeiro".
 * Quem liga já sabe o que quer e ainda assim tem de ouvir o menu inteiro e esperar na fila.
 *
 * Esta consulta o IXC pelo número que ligou, descobre em que situação aquela pessoa está, e
 * abre pelo motivo mais provável. Quem está bloqueado por atraso ouve a oferta de desbloqueio
 * antes de qualquer menu; quem está numa região com falha ouve que já sabemos da falha e não
 * entra na fila do suporte; quem não tem nada pendente ouve o menu normal, curto.
 *
 * ---------------------------------------------------------------------------
 * A regra de privacidade, que é o que torna isto defensável:
 *
 * Bina se falsifica. Reconhecer o número NÃO é confirmar a identidade. Por isso a URA trabalha
 * em dois momentos:
 *
 *   ANTES de confirmar  → pode usar a situação para ORDENAR o menu e para falar da falha na
 *                         região (que é informação da rede, não do contrato). Não diz nome,
 *                         valor, vencimento, nem que o contrato está bloqueado.
 *   DEPOIS de confirmar → (três primeiros do CPF/CNPJ ou data de nascimento) aí sim fala tudo.
 *
 * Quem segura o telefone de alguém não pode descobrir, só ligando, quanto aquela pessoa deve.
 * ---------------------------------------------------------------------------
 */

/**
 * O catálogo. Cada situação tem uma ordem de prioridade (menor vem primeiro), uma fala padrão
 * e o que ela oferece. O provedor liga, desliga e reescreve a fala de cada uma.
 */
const SITUACOES = {
  massiva: {
    ordem: 10,
    nome: 'Falha em massa na região',
    explicacao: 'A equipe já registrou uma falha que atinge a região deste cliente.',
    antes_de_confirmar: true,
    fala: 'Já identificamos uma falha que afeta a sua região e a nossa equipe técnica já está trabalhando nisso.',
    acao: 'informar',
    evita_fila: true,
  },
  bloqueado: {
    ordem: 20,
    nome: 'Acesso bloqueado por atraso',
    explicacao: 'O contrato está suspenso por fatura em aberto — e dá para resolver na hora.',
    antes_de_confirmar: false,
    fala: 'Vi aqui que o seu acesso está suspenso por uma fatura em aberto.',
    acao: 'desbloqueio',
  },
  fatura_vencida: {
    ordem: 30,
    nome: 'Fatura vencida',
    explicacao: 'Há fatura em aberto já vencida, mas o acesso ainda não foi suspenso.',
    antes_de_confirmar: false,
    fala: 'Vi que você tem uma fatura em aberto.',
    acao: 'segunda_via',
  },
  fatura_a_vencer: {
    ordem: 40,
    nome: 'Fatura perto do vencimento',
    explicacao: 'A fatura vence nos próximos dias.',
    antes_de_confirmar: false,
    fala: 'A sua fatura vence em breve.',
    acao: 'segunda_via',
  },
  sem_conexao: {
    ordem: 50,
    nome: 'Conexão fora do ar agora',
    explicacao: 'O login do cliente está offline no IXC neste momento.',
    antes_de_confirmar: false,
    fala: 'Vi que a sua conexão está fora do ar neste momento.',
    acao: 'suporte',
  },
};

const LISTA = Object.keys(SITUACOES);
const ACOES = {
  informar: 'Só avisa e encerra bem',
  desbloqueio: 'Oferece o desbloqueio de confiança',
  segunda_via: 'Oferece a segunda via da fatura',
  suporte: 'Leva para o suporte técnico',
};

/** A configuração de uma situação nesta URA: o que o provedor ligou e escreveu. */
function configDa(ura, chave) {
  const base = SITUACOES[chave];
  const salvo = (ura.situacoes ?? {})[chave] ?? {};
  return {
    chave,
    nome: base.nome,
    explicacao: base.explicacao,
    ordem: base.ordem,
    antes_de_confirmar: base.antes_de_confirmar,
    acao: base.acao,
    evita_fila: Boolean(base.evita_fila),
    ativa: salvo.ativa === undefined ? true : Boolean(salvo.ativa),
    fala: String(salvo.fala ?? base.fala),
  };
}

const catalogo = (ura = { situacoes: {} }) => LISTA.map((k) => configDa(ura, k)).sort((a, b) => a.ordem - b.ordem);

/**
 * Olha o que o IXC devolveu e diz em que situações esta pessoa está, da mais urgente para a
 * menos. Recebe os dados já lidos — assim esta função não faz rede e dá para testar à vontade.
 */
function detectar({ contratos = [], faturas = [], logins = [], alertas = [] } = {}, { hoje = new Date().toISOString().slice(0, 10), diasAviso = 5 } = {}) {
  const achadas = [];

  if (alertas.length) achadas.push({ chave: 'massiva', detalhe: { alertas } });

  if (contratos.some((c) => c.acesso === 'bloqueio_automatico' || c.acesso === 'bloqueado')) {
    achadas.push({ chave: 'bloqueado', detalhe: { contratos: contratos.filter((c) => String(c.acesso ?? '').startsWith('bloque')).map((c) => c.id) } });
  }

  const vencidas = faturas.filter((f) => f.vencimento && f.vencimento < hoje);
  const aVencer = faturas.filter((f) => f.vencimento && f.vencimento >= hoje && diasEntre(hoje, f.vencimento) <= diasAviso);
  if (vencidas.length) achadas.push({ chave: 'fatura_vencida', detalhe: { quantas: vencidas.length, mais_antiga: vencidas[0] } });
  else if (aVencer.length) achadas.push({ chave: 'fatura_a_vencer', detalhe: { quantas: aVencer.length, proxima: aVencer[0] } });

  if (logins.length && logins.every((l) => l.online === false)) achadas.push({ chave: 'sem_conexao', detalhe: { logins: logins.length } });

  return achadas.sort((a, b) => SITUACOES[a.chave].ordem - SITUACOES[b.chave].ordem);
}

const diasEntre = (de, ate) => Math.round((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86_400_000);

/**
 * O roteiro do primeiro momento da ligação, ANTES de confirmar a identidade.
 *
 * Reconhecer o número muda a ORDEM do menu e permite falar da falha na região. Nada do contrato
 * é dito aqui: Bina se falsifica, e quem está com o telefone de outra pessoa não pode descobrir
 * a situação financeira dela só ligando.
 */
function abertura(ura, { identificado = false, situacoes = [] } = {}) {
  const ligadas = situacoes.map((s) => configDa(ura, s.chave)).filter((c) => c.ativa);
  const agoraPode = ligadas.filter((c) => c.antes_de_confirmar);

  // Falha na região é informação da rede, não do contrato: pode ser dita de cara, e é ela que
  // evita a ligação virar mais um chamado do mesmo problema.
  if (agoraPode.length) {
    const c = agoraPode[0];
    return {
      fase: 'informar',
      situacao: c.chave,
      fala: c.fala,
      evita_fila: c.evita_fila,
      opcoes: [
        { digito: '1', rotulo: 'Já resolve, obrigado', acao: 'encerrar' },
        { digito: ura.tecla_atendente, rotulo: 'Falar com um atendente', acao: 'fila', destino_id: ura.fila_padrao_id },
      ],
    };
  }

  if (identificado) {
    return {
      fase: 'confirmar',
      situacao: null,
      // A URA sabe que há algo a tratar, mas não diz o quê antes de saber com quem fala.
      fala: ligadas.length
        ? 'Reconheci o seu número. Para eu te ajudar com o seu contrato, digite os três primeiros números do CPF ou CNPJ do titular.'
        : 'Reconheci o seu número. Digite os três primeiros números do CPF ou CNPJ do titular, ou aperte a tecla do atendente.',
      opcoes: [{ digito: ura.tecla_atendente, rotulo: 'Falar com um atendente', acao: 'fila', destino_id: ura.fila_padrao_id }],
    };
  }

  return {
    fase: 'menu',
    situacao: null,
    fala: ura.mensagem,
    opcoes: [
      ...(ura.opcoes ?? []).map((o) => ({ digito: o.digito, rotulo: o.rotulo ?? null, acao: o.destino_tipo, destino_id: o.destino_id })),
      { digito: ura.tecla_atendente, rotulo: 'Falar com um atendente', acao: 'fila', destino_id: ura.fila_padrao_id },
    ],
  };
}

/**
 * O roteiro DEPOIS da identidade confirmada: agora pode falar do contrato.
 * É aqui que a URA deixa de ser menu e vira atendimento — a situação mais urgente vira a
 * primeira oferta, e quase sempre resolve sem fila.
 */
function aposConfirmar(ura, { situacoes = [], primeiroNome = null } = {}) {
  const ligadas = situacoes.map((s) => configDa(ura, s.chave)).filter((c) => c.ativa);
  const ola = primeiroNome ? `Oi, ${primeiroNome}! ` : '';

  if (!ligadas.length) {
    return {
      fase: 'menu',
      situacao: null,
      fala: `${ola}${ura.mensagem}`,
      opcoes: [
        ...(ura.opcoes ?? []).map((o) => ({ digito: o.digito, rotulo: o.rotulo ?? null, acao: o.destino_tipo, destino_id: o.destino_id })),
        { digito: ura.tecla_atendente, rotulo: 'Falar com um atendente', acao: 'fila', destino_id: ura.fila_padrao_id },
      ],
    };
  }

  const c = ligadas[0];
  const oferta = {
    desbloqueio: { digito: '1', rotulo: 'Liberar o acesso agora', acao: 'desbloqueio' },
    segunda_via: { digito: '1', rotulo: 'Receber a segunda via', acao: 'segunda_via' },
    suporte: { digito: '1', rotulo: 'Falar com o suporte técnico', acao: 'fila', destino_id: ura.fila_padrao_id },
    informar: { digito: '1', rotulo: 'Entendi, obrigado', acao: 'encerrar' },
  }[c.acao];

  return {
    fase: 'oferta',
    situacao: c.chave,
    fala: `${ola}${c.fala}`,
    evita_fila: c.evita_fila,
    opcoes: [
      oferta,
      { digito: '2', rotulo: 'Ouvir as outras opções', acao: 'menu' },
      { digito: ura.tecla_atendente, rotulo: 'Falar com um atendente', acao: 'fila', destino_id: ura.fila_padrao_id },
    ],
    // As outras situações continuam valendo: a URA pode oferecer depois, se a primeira resolver.
    tambem: ligadas.slice(1).map((x) => ({ situacao: x.chave, fala: x.fala })),
  };
}

// ---------- Leitura e gravação ----------

const comoPublica = (u) => ({
  ...u,
  opcoes: (() => { try { return JSON.parse(u.opcoes); } catch { return []; } })(),
  situacoes: (() => { try { return JSON.parse(u.situacoes); } catch { return {}; } })(),
});

const buscar = (db, empresaId, id) => {
  const u = db.prepare('SELECT * FROM uras WHERE id = ? AND empresa_id = ?').get(Number(id), empresaId);
  if (!u) throw naoEncontrado('URA');
  return comoPublica(u);
};

/** Salva a parte inteligente: o tipo, as situações, a fila de escape e as teclas de segurança. */
function salvarInteligencia(db, empresaId, id, dados = {}) {
  const u = buscar(db, empresaId, id);
  const d = dados ?? {};
  const tipo = d.tipo === undefined ? u.tipo : v.opcao(d.tipo, 'o tipo da URA', ['classica', 'inteligente']);

  const situacoes = {};
  for (const chave of LISTA) {
    const vindo = (d.situacoes ?? {})[chave];
    if (vindo === undefined) { if (u.situacoes[chave]) situacoes[chave] = u.situacoes[chave]; continue; }
    situacoes[chave] = {
      ativa: v.booleano(vindo.ativa ?? true) ? 1 : 0,
      fala: v.texto(vindo.fala ?? SITUACOES[chave].fala, `a fala de "${SITUACOES[chave].nome}"`, 600),
    };
  }

  const filaId = d.fila_padrao_id === undefined ? u.fila_padrao_id
    : (d.fila_padrao_id ? Number(d.fila_padrao_id) : null);
  if (filaId) {
    const existe = db.prepare('SELECT 1 FROM filas WHERE id = ? AND empresa_id = ?').get(filaId, empresaId);
    if (!existe) throw new ErroNegocio('A fila escolhida não é desta empresa.');
  }
  const tecla = d.tecla_atendente === undefined ? u.tecla_atendente : String(d.tecla_atendente).trim();
  v.exigir(/^[0-9*#]$/.test(tecla), 'A tecla do atendente tem de ser um dígito, * ou #.');
  // A tecla do atendente entra em todo menu: não pode coincidir com uma opção da URA nem, na
  // inteligente, com o 1 e o 2 que a oferta e o aviso usam.
  v.exigir(!(u.opcoes ?? []).some((o) => String(o.digito) === tecla), `A tecla ${tecla} já é uma opção do menu desta URA.`);
  if (tipo === 'inteligente') v.exigir(!['1', '2'].includes(tecla), 'Na URA inteligente, o 1 e o 2 são da oferta: escolha outra tecla para o atendente.');
  // Sem fila de escape, uma URA inteligente pode deixar o cliente sem saída quando o IXC cair.
  if (tipo === 'inteligente') v.exigir(filaId, 'Escolha a fila que recebe quem pede atendente: a URA não pode prender ninguém.');

  db.prepare(`UPDATE uras SET tipo = ?, situacoes = ?, fila_padrao_id = ?, tecla_atendente = ?, max_tentativas = ? WHERE id = ?`)
    .run(tipo, JSON.stringify(situacoes), filaId, tecla,
      d.max_tentativas === undefined ? u.max_tentativas : v.inteiro(d.max_tentativas, 'o número de tentativas', { min: 1, max: 5 }), u.id);
  return buscar(db, empresaId, u.id);
}

module.exports = { SITUACOES, LISTA, ACOES, catalogo, configDa, detectar, abertura, aposConfirmar, buscar, comoPublica, salvarInteligencia, diasEntre, agora };
