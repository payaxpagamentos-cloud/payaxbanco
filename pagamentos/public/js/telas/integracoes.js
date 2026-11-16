import { api, ir, pode } from '../app.js';
import {
  el, montar, cartao, tabela, campo, lerForm, modal, toast, acao, aviso, selo, copiar, statusIntegracao,
  numero, dataHora, data, hojeIso, somarDias, R, icone
} from '../../comum/ui.js';

/**
 * As APIs da PAY AX: o banco que registra os boletos (Bradesco) e a consulta de CEP e CNPJ (API Brasil).
 * O sistema de gestão de cada cliente é do cliente: fica no cadastro dele (Clientes → Acessos e sistema).
 */

export default async function integracoes({ alvo, recarregar }) {
  const d = await api.get('/integracoes');

  montar(alvo, 
    el('div', { class: 'cabecalho-tela' }, el('div', {}, el('h1', {}, 'Integrações'),
      el('p', {}, 'As APIs da PAY AX: o banco que registra os boletos e a consulta de CEP e CNPJ. O sistema de gestão de cada cliente fica no cadastro dele (Clientes → Acessos e sistema).'))),

    cartao(['Bradesco — Cobrança Registrada e Bolepix ', statusIntegracao({ ...d.banco, configurada: d.banco.configurada, modo: d.banco.modo }, { grande: true })],
      el('div', {},
        d.banco.modo === 'simulador'
          ? aviso('Modo SIMULADOR ativo: os títulos são registrados localmente, com código de barras e BR Code válidos. Nenhuma chamada é feita ao banco. Para ligar o ambiente real, configure as credenciais abaixo e inicie o servidor com PAYAX_BANCO_MODO=bradesco.', 'aviso')
          : aviso(`Modo real · ambiente de ${d.banco.ambiente}.`, 'info'),
        el('div', { class: 'pares', style: 'margin-top:12px' },
          el('div', { class: 'par' }, el('span', { class: 'rot' }, 'Status'), el('span', { class: 'val' }, statusIntegracao({ ...d.banco, modo: d.banco.modo }))),
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

    el('div', { style: 'margin-top:18px' }, cartao(['Consulta de CEP e CNPJ (API Brasil) ', statusApiBrasil(d.dados)],
      el('div', {},
        el('p', { style: 'color:var(--texto-2);font-size:13px;margin-bottom:12px' },
          'Preenche sozinho o cadastro de clientes e os dados do pagador. O resultado fica em cache, então o mesmo CEP ou CNPJ não é consultado duas vezes.'),
        el('div', { class: 'pares cols-3' },
          el('div', { class: 'par' }, el('span', { class: 'rot' }, 'Status da API'), el('span', { class: 'val' }, statusApiBrasil(d.dados, true))),
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
          toast(r.mensagem, r.ok ? 'ok' : 'erro');
          recarregar();
        }) }, icone('atualizar'), 'Testar consulta'),
        pode('*') ? el('button', { class: 'botao', onclick: () => configurarDados(d.dados, recarregar) }, icone('config'), 'Token da API Brasil') : null))),

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

/**
 * Status da API Brasil: verde quando o último teste passou, vermelho quando falhou.
 * Sem token: âmbar se o CNPJ deveria sair por ela (está usando a fonte pública), cinza se não.
 */
function statusApiBrasil(dados, texto = false) {
  const tabela = {
    ok: ['Funcionando', 'ok'],
    falha: ['Com falha', 'erro'],
    nao_testada: ['Não testada: clique em Testar consulta', 'neutra'],
    sem_token: ['Sem token: usando a fonte pública', 'aviso'],
    publica: ['Fonte pública (sem token)', 'neutra'],
  };
  const chave = !dados.apibrasil_configurada ? (dados.cnpj?.escolhida === 'apibrasil' ? 'sem_token' : 'publica')
    : dados.estado === 'conectada' ? 'ok' : dados.estado === 'falha' ? 'falha' : 'nao_testada';
  const s = selo(chave, tabela);
  if (!texto) s.classList.add('grande');
  return s;
}

function configurarDados(atual, recarregar) {
  const form = el('form', { onsubmit: (e) => e.preventDefault() },
    campo({ nome: 'token', rotulo: 'Token da API Brasil', tipo: 'password',
      ajuda: atual.apibrasil_configurada ? 'Deixe vazio para remover o token (volta à fonte pública)'
        : 'O "Bearer Token" do painel da API Brasil (vale 1 ano). O DeviceToken não é usado nesta consulta.' }));
  const botao = el('button', { class: 'botao' }, 'Salvar token');
  botao.addEventListener('click', () => acao(botao, async () => {
    const dados = lerForm(form);
    await api.put('/integracoes/dados', dados);
    m.fechar();
    // Com token novo, testa na hora: o status já aparece verde (ou vermelho, com o motivo).
    if (dados.token) {
      const r = await api.post('/integracoes/dados/testar', {}).catch((err) => ({ ok: false, mensagem: err.message }));
      toast(r.ok ? 'Token salvo e testado: a API Brasil está funcionando.' : `Token salvo, mas o teste falhou: ${r.mensagem}`, r.ok ? 'ok' : 'erro');
    } else {
      toast('Token removido: as consultas usam a fonte pública.', 'ok');
    }
    recarregar();
  }));
  const m = modal({ titulo: 'API Brasil · consulta de CEP e CNPJ',
    corpo: [aviso('O token é cifrado antes de ser gravado e nunca volta para a tela. Sem token, as consultas usam a fonte pública, que não tem custo. Com token, o CNPJ sai pela API Brasil (crédito por consulta, guardado por 30 dias para não pagar duas vezes); o CEP continua na fonte pública.', 'info'), form],
    acoes: [el('button', { class: 'botao sec', onclick: () => m.fechar() }, 'Cancelar'), botao] });
}

