'use strict';

/**
 * O que cada pessoa pode ver e fazer.
 *
 * O perfil é um ponto de partida, não uma cerca: define um conjunto de permissões, e depois
 * cada pessoa pode receber algo a mais ou perder algo. É isso que permite ter um atendente que
 * também cuida da Ouvidoria, ou um supervisor que vê relatório mas não vê o CPF do cliente.
 *
 * Duas regras valem acima de qualquer ajuste:
 *  - o master da plataforma tem tudo, sempre (senão ninguém conserta nada quando dá errado);
 *  - permissão que o perfil não tem e ninguém concedeu não existe — o padrão é não poder.
 *
 * E a regra que não pode ser esquecida em nenhuma tela: esconder o botão não é permissão.
 * Toda permissão aqui tem de ser conferida também no servidor, na rota.
 */

/** Cada item: a chave, o que ela libera e em que grupo aparece na tela. */
const CATALOGO = [
  // ---------- Atendimento ----------
  ['atendimentos.ver', 'Atendimentos', 'Ver a caixa de conversas', 'Abrir a lista e ler as conversas.'],
  ['atendimentos.atender', 'Atendimentos', 'Assumir e responder', 'Pegar conversa para si e mandar mensagem ao cliente.'],
  ['atendimentos.transferir', 'Atendimentos', 'Transferir e encerrar', 'Passar para outra fila ou pessoa e fechar a conversa.'],
  ['atendimentos.notas', 'Atendimentos', 'Escrever notas internas', 'Notas que o cliente não vê.'],
  ['atendimentos.etiquetas', 'Atendimentos', 'Marcar etiquetas', 'Classificar a conversa.'],

  // ---------- Dados do cliente ----------
  ['cliente.ver', 'Dados do cliente', 'Ver contatos', 'A lista de quem já falou com a empresa.'],
  ['cliente.editar', 'Dados do cliente', 'Editar contato', 'Nome, e-mail, bloqueio e aceite de mensagens ativas.'],
  ['cliente.documento', 'Dados do cliente', 'Ver CPF/CNPJ completo', 'Sem isto, o documento aparece com o miolo escondido: 123••••••09.'],
  ['cliente.ficha', 'Dados do cliente', 'Ver a ficha 360° e o risco', 'Histórico completo, score de risco e valor do cliente.'],
  ['cliente.financeiro', 'Dados do cliente', 'Ver faturas e valores', 'Situação financeira do cliente no provedor.'],

  // ---------- Chamados e Ouvidoria ----------
  ['chamados.ver', 'Chamados e Ouvidoria', 'Ver chamados', 'Os pedidos registrados.'],
  ['chamados.editar', 'Chamados e Ouvidoria', 'Tratar chamados', 'Mudar situação e escrever a resolução.'],
  ['ouvidoria.ver', 'Chamados e Ouvidoria', 'Ver a Ouvidoria', 'Reclamações, cancelamentos, Procon e Anatel.'],
  ['ouvidoria.editar', 'Chamados e Ouvidoria', 'Tratar a Ouvidoria', 'Abrir, andar e encerrar casos.'],

  // ---------- ZOE ----------
  ['zoe.ver', 'ZOE', 'Ver a ZOE', 'Desempenho, base de conhecimento, intenções e ferramentas.'],
  ['zoe.editar', 'ZOE', 'Configurar a ZOE', 'Mudar como ela atende, o que ela sabe e o que ela pode fazer.'],
  ['zoe.alertas', 'ZOE', 'Cadastrar alertas de rede', 'Declarar falha em massa e manutenção programada.'],
  ['zoe.testar', 'ZOE', 'Testar a ZOE', 'Conversar com ela sem gastar mensagem com cliente.'],

  // ---------- Dinheiro ----------
  ['custos.ver', 'Centro de Custo', 'Ver a conta da Meta', 'Gasto, economia, orçamento e fechamento.'],
  ['custos.editar', 'Centro de Custo', 'Mexer em réguas e orçamento', 'Criar régua, disparar, definir teto e lançar a fatura.'],

  // ---------- Operação ----------
  ['filas.ver', 'Operação', 'Ver filas', 'Como o atendimento humano está organizado.'],
  ['filas.editar', 'Operação', 'Configurar filas', 'Criar fila, horário e quem atende cada uma.'],
  ['relatorios.ver', 'Operação', 'Ver relatórios', 'Números do atendimento no período.'],

  // ---------- Administração ----------
  ['usuarios.ver', 'Administração', 'Ver usuários', 'A lista de quem tem acesso.'],
  ['usuarios.editar', 'Administração', 'Cadastrar e editar usuários', 'Criar pessoa, trocar perfil e ajustar permissões.'],
  ['configuracoes.ver', 'Administração', 'Ver configurações', 'Dados da empresa, horário e mensagens padrão.'],
  ['configuracoes.editar', 'Administração', 'Mudar configurações', 'Alterar o que a empresa tem configurado.'],
  ['integracoes.ver', 'Administração', 'Ver integrações', 'WhatsApp, IXC e chaves de API.'],
  ['integracoes.editar', 'Administração', 'Configurar integrações', 'Ligar o WhatsApp e o IXC, criar e revogar chaves.'],
];

const TODAS = CATALOGO.map(([chave]) => chave);
const EXISTE = new Set(TODAS);
const DESCRICAO = new Map(CATALOGO.map(([chave, grupo, rotulo, ajuda]) => [chave, { chave, grupo, rotulo, ajuda }]));
const GRUPOS = [...new Set(CATALOGO.map(([, grupo]) => grupo))];

/**
 * O que cada perfil traz de fábrica.
 *
 * O atendente atende: não vê dinheiro, não configura nada e não vê a ficha de risco — ela existe
 * para decidir retenção, não para ficar aberta na mesa de todo mundo. O supervisor vê quase tudo
 * e não muda nada. O administrador da empresa faz tudo dentro dela.
 */
const PADRAO = {
  master: TODAS,
  suporte: TODAS,
  cliente: TODAS,
  supervisor: [
    'atendimentos.ver', 'cliente.ver', 'chamados.ver', 'ouvidoria.ver',
    'zoe.ver', 'custos.ver', 'filas.ver', 'relatorios.ver', 'usuarios.ver', 'configuracoes.ver',
  ],
  atendente: [
    'atendimentos.ver', 'atendimentos.atender', 'atendimentos.transferir', 'atendimentos.notas', 'atendimentos.etiquetas',
    'cliente.ver', 'cliente.editar', 'cliente.financeiro',
    'chamados.ver', 'chamados.editar', 'ouvidoria.ver',
  ],
};

const PERFIS = {
  master: 'Master da plataforma',
  suporte: 'Suporte da plataforma',
  cliente: 'Administrador da empresa',
  supervisor: 'Supervisor (consulta)',
  atendente: 'Atendente',
};

// Perfis que mandam na plataforma inteira: não se mexe nas permissões deles pelo painel da empresa.
const PLATAFORMA = ['master', 'suporte'];

const doPerfil = (perfil) => new Set(PADRAO[perfil] ?? []);

/**
 * As permissões que valem para esta pessoa: o padrão do perfil, mais o que foi concedido à mão,
 * menos o que foi revogado à mão. O master nunca perde nada.
 */
function efetivas(db, usuario) {
  if (!usuario) return new Set();
  if (usuario.perfil === 'master') return new Set(TODAS);
  const set = doPerfil(usuario.perfil);
  const ajustes = db.prepare('SELECT permissao, concedida FROM usuario_permissoes WHERE usuario_id = ?').all(usuario.id);
  for (const a of ajustes) {
    if (!EXISTE.has(a.permissao)) continue;
    if (a.concedida) set.add(a.permissao);
    else set.delete(a.permissao);
  }
  return set;
}

const pode = (db, usuario, permissao) => efetivas(db, usuario).has(permissao);

/**
 * Grava os ajustes de uma pessoa. Recebe a lista do que ela DEVE poder; a diferença contra o
 * perfil vira concessão ou revogação. Guardar a diferença, e não a lista inteira, faz com que
 * mudar o padrão de um perfil alcance quem nunca foi ajustado à mão.
 */
function definir(db, usuarioId, perfil, permissoes = []) {
  const desejadas = new Set([].concat(permissoes).filter((p) => EXISTE.has(p)));
  const padrao = doPerfil(perfil);
  db.prepare('DELETE FROM usuario_permissoes WHERE usuario_id = ?').run(usuarioId);
  const inserir = db.prepare('INSERT INTO usuario_permissoes (usuario_id, permissao, concedida) VALUES (?, ?, ?)');
  for (const p of TODAS) {
    const quer = desejadas.has(p);
    const tem = padrao.has(p);
    if (quer !== tem) inserir.run(usuarioId, p, quer ? 1 : 0);
  }
  return desejadas;
}

/** O que a tela precisa para desenhar o editor: catálogo, padrão do perfil e o que está valendo. */
function paraEditor(db, usuario) {
  const padrao = doPerfil(usuario.perfil);
  const agora = efetivas(db, usuario);
  return {
    grupos: GRUPOS.map((grupo) => ({
      grupo,
      itens: CATALOGO.filter(([, g]) => g === grupo).map(([chave, , rotulo, ajuda]) => ({
        chave, rotulo, ajuda, do_perfil: padrao.has(chave), ativa: agora.has(chave),
      })),
    })),
    perfil: usuario.perfil,
    perfil_nome: PERFIS[usuario.perfil] ?? usuario.perfil,
    ajustada: TODAS.some((p) => padrao.has(p) !== agora.has(p)),
  };
}

/**
 * Esconde o miolo do CPF/CNPJ de quem não tem `cliente.documento`.
 * Deixa o começo e o fim porque o atendente precisa conferir com o cliente sem ver o documento
 * inteiro — "termina em 09" resolve a conferência e não entrega o dado.
 */
function mascararDocumento(documento, podeVer) {
  const d = String(documento ?? '').replace(/\D/g, '');
  if (!d) return documento ?? null;
  if (podeVer) return documento;
  if (d.length <= 4) return '•'.repeat(d.length);
  return `${d.slice(0, 3)}${'•'.repeat(d.length - 5)}${d.slice(-2)}`;
}

module.exports = { CATALOGO, TODAS, GRUPOS, PERFIS, PADRAO, PLATAFORMA, DESCRICAO, efetivas, pode, definir, doPerfil, paraEditor, mascararDocumento, EXISTE };
