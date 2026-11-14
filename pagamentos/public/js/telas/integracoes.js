import { api, ir, pode } from '../app.js';
import {
  el, montar, cartao, tabela, campo, lerForm, modal, toast, acao, aviso, selo, copiar,
  numero, dataHora, data, hojeIso, somarDias, R, icone
} from '../../comum/ui.js';

/** Banco (Bradesco) e o IXC de cada cliente. */
export default async function integracoes({ alvo, recarregar }) {
  const d = await api.get('/integracoes');
  const clientes = (await api.get('/clientes?por_pagina=200')).itens;
  const porCliente = Object.fromEntries(d.ixc.map((i) => [i.cliente_id, i]));

  montar(alvo, 
    el('div', { class: 'cabecalho-tela' }, el('div', {}, el('h1', {}, 'Integrações'),
      el('p', {}, 'O banco que registra os boletos e o IXC de cada cliente.'))),

    cartao('Bradesco — Cobrança Registrada e Bolepix',
      el('div', {},
        d.banco.modo === 'simulador'
          ? aviso('Modo SIMULADOR ativo: os títulos são registrados localmente, com código de barras e BR Code válidos. Nenhuma chamada é feita ao banco. Para ligar o ambiente real, configure as credenciais abaixo e inicie o servidor com PAYAX_BANCO_MODO=bradesco.', 'aviso')
          : aviso(`Modo real · ambiente de ${d.banco.ambiente}.`, 'info'),
        el('div', { class: 'pares', style: 'margin-top:12px' },
          el('div', { class: 'par' }, el('span', { class: 'rot' }, 'Estado'), el('span', { class: 'val' }, selo(d.banco.estado ?? 'nao_configurada', R.estadoIntegracao))),
          el('div', { class: 'par' }, el('span', { class: 'rot' }, 'Credenciais'), el('span', { class: 'val' }, d.banco.configurada ? 'cadastradas' : 'não cadastradas')),
          el('div', { class: 'par' }, el('span', { class: 'rot' }, 'Último teste'), el('span', { class: 'val' }, d.banco.ultimo_teste ? dataHora(d.banco.ultimo_teste) : '—'))),
        d.banco.ultimo_erro ? el('div', { style: 'margin-top:10px' }, aviso(d.banco.ultimo_erro, 'erro')) : null),
      el('div', { style: 'display:flex;gap:8px' },
        el('button', { class: 'botao sec', onclick: (e) => acao(e.currentTarget, async () => {
          const r = await api.post('/integracoes/banco/testar', {});
          toast(r.mensagem ?? 'Conexão testada.', 'ok');
          recarregar();
        }) }, icone('atualizar'), 'Testar conexão'),
        pode('*') ? el('button', { class: 'botao', onclick: () => configurarBanco(d.banco, recarregar) }, icone('config'), 'Configurar') : null)),

    el('div', { style: 'margin-top:18px' }, cartao('Consulta de CEP e CNPJ (API Brasil)',
      el('div', {},
        el('p', { style: 'color:var(--texto-2);font-size:13px;margin-bottom:12px' },
          'Preenche sozinho o cadastro de clientes e os dados do pagador. O resultado fica em cache, então o mesmo CEP ou CNPJ não é consultado duas vezes.'),
        el('div', { class: 'pares' },
          el('div', { class: 'par' }, el('span', { class: 'rot' }, 'Token da API Brasil'),
            el('span', { class: 'val' }, d.dados.apibrasil_configurada ? 'cadastrado' : 'não cadastrado')),
          el('div', { class: 'par' }, el('span', { class: 'rot' }, 'Fonte do CEP'),
            el('span', { class: 'val' }, d.dados.cep.fonte === 'apibrasil' ? 'API Brasil (consome crédito)' : 'Consulta pública (sem custo)')),
          el('div', { class: 'par' }, el('span', { class: 'rot' }, 'Fonte do CNPJ'),
            el('span', { class: 'val' }, d.dados.cnpj.fonte === 'apibrasil' ? 'API Brasil (consome crédito)' : 'Consulta pública (sem custo)')),
          el('div', { class: 'par' }, el('span', { class: 'rot' }, 'Em cache'),
            el('span', { class: 'val' }, d.dados.cache.map((x) => `${numero(x.n)} ${x.tipo.toUpperCase()}`).join(' · ') || 'nada ainda')),
          el('div', { class: 'par' }, el('span', { class: 'rot' }, 'Último teste'),
            el('span', { class: 'val' }, d.dados.ultimo_teste ? dataHora(d.dados.ultimo_teste) : '—'))),
        d.dados.cnpj.escolhida === 'apibrasil' && d.dados.cnpj.fonte !== 'apibrasil'
          ? el('div', { style: 'margin-top:10px' }, aviso('O CNPJ está configurado para a API Brasil, mas não há token: as consultas estão saindo pela fonte pública.', 'aviso'))
          : null,
        d.dados.ultimo_erro ? el('div', { style: 'margin-top:10px' }, aviso(d.dados.ultimo_erro, 'erro')) : null,
        el('p', { style: 'margin-top:10px;color:var(--texto-3);font-size:12.5px' },
          'A fonte de cada tipo é escolhida no servidor, em PAYAX_CEP_FONTE e PAYAX_CNPJ_FONTE (publica ou apibrasil).')),
      el('div', { style: 'display:flex;gap:8px' },
        el('button', { class: 'botao sec', onclick: (e) => acao(e.currentTarget, async () => {
          const r = await api.post('/integracoes/dados/testar', {});
          toast(r.mensagem, 'ok');
          recarregar();
        }) }, icone('atualizar'), 'Testar consulta'),
        pode('*') ? el('button', { class: 'botao', onclick: () => configurarDados(d.dados, recarregar) }, icone('config'), 'Token da API Brasil') : null))),

    el('div', { style: 'margin-top:18px' }, cartao('IXC dos clientes', tabela({
      colunas: [
        { titulo: 'Cliente', conteudo: (c) => el('span', {}, el('span', { class: 'forte' }, c.nome_fantasia || c.razao_social),
          el('span', { class: 'sub' }, porCliente[c.id]?.config?.url ?? 'sem endereço configurado')) },
        { titulo: 'Estado', conteudo: (c) => selo(porCliente[c.id]?.estado ?? 'nao_configurada', R.estadoIntegracao) },
        { titulo: 'Importação automática', conteudo: (c) => (porCliente[c.id]?.config?.importacao_automatica ? 'Ligada' : 'Desligada') },
        { titulo: 'Último teste', conteudo: (c) => (porCliente[c.id]?.ultimo_teste ? dataHora(porCliente[c.id].ultimo_teste) : '—') },
        { titulo: '', dir: true, conteudo: (c) => el('div', { style: 'display:flex;gap:6px;justify-content:flex-end' },
          porCliente[c.id]?.configurada ? el('button', { class: 'botao sec pequeno', onclick: (e) => { e.stopPropagation(); acao(e.currentTarget, async () => {
            const r = await api.post(`/integracoes/ixc/${c.id}/testar`, {});
            toast(`IXC conectado · ${numero(r.clientes)} cliente(s) na base.`, 'ok');
            recarregar();
          }); } }, 'Testar') : null,
          porCliente[c.id]?.configurada ? el('button', { class: 'botao pequeno', onclick: (e) => { e.stopPropagation(); importar(c, recarregar); } }, icone('importar'), 'Importar') : null,
          el('button', { class: 'botao sec pequeno', onclick: (e) => { e.stopPropagation(); configurarIxc(c, porCliente[c.id], recarregar); } }, 'Configurar')) },
      ],
      itens: clientes,
      vazio: 'Cadastre clientes para configurar o IXC de cada um.',
    }))),

    el('div', { style: 'margin-top:18px' }, cartao('Últimos sincronismos', tabela({
      colunas: [
        { titulo: 'Quando', conteudo: (s) => dataHora(s.inicio) },
        { titulo: 'Cliente', conteudo: (s) => s.razao_social },
        { titulo: 'Tipo', conteudo: (s) => ({ importacao: 'Importação', baixa: 'Baixa no IXC', teste: 'Teste' }[s.tipo] ?? s.tipo) },
        { titulo: 'Lidos', dir: true, conteudo: (s) => numero(s.lidos) },
        { titulo: 'Criados', dir: true, conteudo: (s) => numero(s.criados) },
        { titulo: 'Ignorados', dir: true, conteudo: (s) => numero(s.ignorados) },
        { titulo: 'Erros', dir: true, conteudo: (s) => el('span', { style: s.erros ? 'color:var(--vermelho);font-weight:600' : '' }, numero(s.erros)) },
      ],
      itens: d.sincronismos,
      vazio: 'Nenhum sincronismo ainda.',
      aoClicar: (s) => (s.detalhe ? modal({ titulo: 'Detalhe do sincronismo', corpo: el('div', { class: 'codigo' }, s.detalhe) }) : null),
    }))),
  );
}

function configurarBanco(atual, recarregar) {
  const form = el('form', { onsubmit: (e) => e.preventDefault() },
    el('div', { class: 'linha-form' },
      campo({ nome: 'ambiente', rotulo: 'Ambiente', tipo: 'select', valor: atual?.config?.ambiente ?? 'homologacao',
        opcoes: [['homologacao', 'Homologação'], ['producao', 'Produção']] }),
      campo({ nome: 'client_id', rotulo: 'client_id', obrigatorio: true })),
    el('div', { style: 'margin-top:12px;display:grid;gap:12px' },
      campo({ nome: 'client_secret', rotulo: 'client_secret', tipo: 'password' }),
      campo({ nome: 'certificado_pem', rotulo: 'Certificado (PEM)', tipo: 'textarea', ajuda: 'Conteúdo do arquivo .pem fornecido pelo Bradesco' }),
      campo({ nome: 'chave_privada_pem', rotulo: 'Chave privada (PEM)', tipo: 'textarea', ajuda: 'Começa com -----BEGIN PRIVATE KEY-----' }),
      campo({ nome: 'chave_senha', rotulo: 'Senha da chave privada', tipo: 'password' })));
  const botao = el('button', { class: 'botao' }, 'Salvar credenciais');
  botao.addEventListener('click', () => acao(botao, async () => {
    const r = await api.put('/integracoes/banco', lerForm(form));
    m.fechar();
    modal({ titulo: 'Credenciais salvas',
      corpo: [el('p', {}, 'Cadastre este endereço no portal do Bradesco para receber os avisos de liquidação:'),
        el('div', { class: 'codigo' }, `${location.origin}${r.webhook_caminho}`)],
      acoes: [el('button', { class: 'botao', onclick: () => copiar(`${location.origin}${r.webhook_caminho}`) }, icone('copiar'), 'Copiar endereço')] });
    recarregar();
  }));
  const m = modal({ titulo: 'Credenciais do Bradesco', largo: true,
    corpo: [aviso('O certificado e a chave privada são cifrados (AES-256-GCM) antes de serem gravados e nunca voltam para a tela.', 'info'), form],
    acoes: [el('button', { class: 'botao sec', onclick: () => m.fechar() }, 'Cancelar'), botao] });
}

function configurarDados(atual, recarregar) {
  const form = el('form', { onsubmit: (e) => e.preventDefault() },
    campo({ nome: 'token', rotulo: 'Token da API Brasil', tipo: 'password',
      ajuda: atual.apibrasil_configurada ? 'Deixe vazio para remover o token (volta à fonte pública)' : 'O mesmo Bearer token da sua conta na API Brasil' }));
  const botao = el('button', { class: 'botao' }, 'Salvar token');
  botao.addEventListener('click', () => acao(botao, async () => {
    await api.put('/integracoes/dados', lerForm(form));
    m.fechar();
    toast('Token salvo.', 'ok');
    recarregar();
  }));
  const m = modal({ titulo: 'API Brasil · consulta de CEP e CNPJ',
    corpo: [aviso('O token é cifrado antes de ser gravado e nunca volta para a tela. Sem token, as consultas usam a fonte pública, que não tem custo.', 'info'), form],
    acoes: [el('button', { class: 'botao sec', onclick: () => m.fechar() }, 'Cancelar'), botao] });
}

function configurarIxc(cliente, atual, recarregar) {
  const cfg = atual?.config ?? {};
  const form = el('form', { onsubmit: (e) => e.preventDefault() },
    el('div', { class: 'linha-form' },
      campo({ nome: 'url', rotulo: 'Endereço do IXC', valor: cfg.url ?? '', obrigatorio: true, ajuda: 'Ex.: https://ixc.provedor.com.br' }),
      campo({ nome: 'token', rotulo: 'Token (id:hash)', tipo: 'password', ajuda: atual?.configurada ? 'Deixe vazio para manter o token atual' : 'Configurações → Usuários → Token, no IXC' })),
    el('div', { class: 'linha-form', style: 'margin-top:12px' },
      campo({ nome: 'tipo_padrao', rotulo: 'Tipo do boleto', tipo: 'select', valor: cfg.tipo_padrao ?? 'bolepix', opcoes: Object.entries(R.tipoBoleto) }),
      campo({ nome: 'juros_mes', rotulo: 'Juros ao mês (%)', valor: cfg.juros_mes ?? 1, ajuda: 'Máximo 1% ao mês' }),
      campo({ nome: 'multa', rotulo: 'Multa (%)', valor: cfg.multa ?? 2, ajuda: 'Máximo 2% (Código de Defesa do Consumidor)' }),
      campo({ nome: 'dias_a_frente', rotulo: 'Importar vencimentos até (dias)', tipo: 'number', valor: cfg.dias_a_frente ?? 10 }),
      campo({ nome: 'importacao_automatica', rotulo: 'Importação automática', tipo: 'select', valor: cfg.importacao_automatica ? '1' : '0', opcoes: [['0', 'Desligada'], ['1', 'Ligada (todo dia)']] }),
      campo({ nome: 'anotar_no_ixc', rotulo: 'Gravar o boleto no título do IXC', tipo: 'select', valor: cfg.anotar_no_ixc === false ? '0' : '1', opcoes: [['1', 'Sim'], ['0', 'Não']] })),
    el('div', { style: 'margin-top:12px' }, campo({ nome: 'mensagem', rotulo: 'Mensagem padrão no boleto', valor: cfg.mensagem ?? '', atributos: { maxlength: 160 } })));
  const botao = el('button', { class: 'botao' }, 'Salvar');
  botao.addEventListener('click', () => acao(botao, async () => {
    await api.put(`/integracoes/ixc/${cliente.id}`, lerForm(form));
    m.fechar();
    toast('IXC configurado.', 'ok');
    recarregar();
  }));
  const m = modal({ titulo: `IXC de ${cliente.nome_fantasia || cliente.razao_social}`, largo: true,
    corpo: [aviso('O token é cifrado antes de ser gravado. Use um usuário técnico só para a PAY AX no IXC.', 'info'), form],
    acoes: [el('button', { class: 'botao sec', onclick: () => m.fechar() }, 'Cancelar'), botao] });
}

function importar(cliente, recarregar) {
  const form = el('form', { class: 'linha-form', onsubmit: (e) => e.preventDefault() },
    campo({ nome: 'de', rotulo: 'Vencimento de', tipo: 'date', valor: hojeIso() }),
    campo({ nome: 'ate', rotulo: 'até', tipo: 'date', valor: somarDias(hojeIso(), 10) }),
    campo({ nome: 'limite', rotulo: 'Máximo de títulos', tipo: 'number', valor: 200 }));
  const botao = el('button', { class: 'botao' }, icone('importar'), 'Importar e emitir');
  botao.addEventListener('click', () => acao(botao, async () => {
    const r = await api.post(`/integracoes/ixc/${cliente.id}/importar`, lerForm(form));
    m.fechar();
    toast(`${r.criados} boleto(s) emitido(s) · ${r.ignorados} ignorado(s) · ${r.erros} erro(s).`, r.erros ? 'erro' : 'ok');
    recarregar();
  }));
  const m = modal({ titulo: `Importar títulos do IXC · ${cliente.nome_fantasia || cliente.razao_social}`,
    corpo: [aviso('Cada título em aberto do IXC vira um boleto. Títulos já importados são ignorados, então pode rodar quantas vezes quiser.', 'info'), form],
    acoes: [el('button', { class: 'botao sec', onclick: () => m.fechar() }, 'Cancelar'), botao] });
}
