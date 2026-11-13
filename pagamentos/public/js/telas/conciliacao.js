import { api, ir, pode } from '../app.js';
import { qs } from '../../comum/api.js';
import {
  el, montar, cartao, tabela, kpi, campo, lerForm, modal, toast, acao, aviso, selo, copiar,
  dinheiro, numero, dataHora, data, hojeIso, primeiroDiaMes, icone,
} from '../../comum/ui.js';

/** Avisos do banco (webhook e arquivo de retorno) e o que o sistema fez com cada um. */
export default async function conciliacao({ alvo, query, recarregar }) {
  const aba = query.aba ?? 'arquivos';
  montar(alvo,
    el('div', { class: 'cabecalho-tela' }, el('div', {}, el('h1', {}, 'Conciliação'),
      el('p', {}, 'A troca de arquivos com o banco e o destino de cada aviso recebido.'))),
    el('div', { class: 'abas' },
      el('button', { class: aba === 'arquivos' ? 'ativa' : '', onclick: () => ir('#/conciliacao?aba=arquivos') }, 'Arquivos do banco'),
      el('button', { class: aba === 'eventos' ? 'ativa' : '', onclick: () => ir('#/conciliacao?aba=eventos') }, 'Avisos por API')),
    el('div', { id: 'corpo' }));
  const corpo = alvo.querySelector('#corpo');
  if (aba === 'eventos') await abaEventos(corpo, query);
  else await abaArquivos(corpo, recarregar);
}

// ---------------------------------------------------------------- Remessa e retorno (CNAB 400)
async function abaArquivos(alvo, recarregar) {
  const d = await api.get('/arquivos');
  const operar = pode('conciliacao.operar');

  const enviarRetorno = () => {
    const entrada = el('input', { type: 'file', accept: '.RET,.ret,.txt,text/plain' });
    const botao = el('button', { class: 'botao' }, icone('importar'), 'Processar arquivo');
    botao.addEventListener('click', () => acao(botao, async () => {
      const arquivo = entrada.files?.[0];
      if (!arquivo) { toast('Escolha o arquivo de retorno.', 'erro'); return; }
      const r = await api.enviarArquivo('/arquivos/retornos', arquivo);
      m.fechar();
      toast(r.ja_processado
        ? 'Este arquivo já tinha sido processado — nada foi refeito.'
        : `${r.liquidados} liquidado(s), ${r.confirmados} confirmado(s), ${r.rejeitados} rejeitado(s).`, 'ok');
      recarregar();
    }));
    const m = modal({
      titulo: 'Enviar um retorno manualmente',
      corpo: [
        aviso('O caminho normal é a pasta de entrada, varrida sozinha. Use isto quando o arquivo chegou por fora (e-mail, download no Net Empresa) ou para reprocessar.', 'info'),
        el('label', { class: 'campo-form' }, el('span', {}, 'Arquivo de retorno (.RET)'), entrada),
        el('p', { style: 'font-size:12.5px;color:var(--texto-3)' }, 'O mesmo arquivo duas vezes não credita em dobro: ele é reconhecido pelo conteúdo.'),
      ],
      acoes: [el('button', { class: 'botao sec', onclick: () => m.fechar() }, 'Cancelar'), botao],
    });
  };

  const par = (rot, val) => el('div', { class: 'par' }, el('span', { class: 'rot' }, rot), el('span', { class: 'val' }, val));

  montar(alvo,
    d.modo !== 'cnab'
      ? aviso(`O banco está no modo "${d.modo}". A remessa automática só roda no modo arquivo (PAYAX_BANCO_MODO=cnab); o que está aqui continua valendo para enviar e conferir arquivos na mão.`, 'aviso')
      : null,
    d.nao_confirmados
      ? aviso(`${d.nao_confirmados} título(s) foram para a remessa há mais de 2 dias e o banco ainda não confirmou. Confira se o retorno está chegando.`, 'aviso')
      : null,

    el('div', { class: 'grade kpis' },
      kpi({ rotulo: 'Esperando a próxima remessa', valor: numero(d.aguardando_remessa.titulos),
        apoio: dinheiro(d.aguardando_remessa.valor_centavos), tom: d.aguardando_remessa.titulos ? 'destaque' : '', ic: 'importar' }),
      kpi({ rotulo: 'Última remessa', valor: d.ultima_remessa ? `${numero(d.ultima_remessa.titulos)} títulos` : '—',
        apoio: d.ultima_remessa ? `${d.ultima_remessa.nome} · ${dataHora(d.ultima_remessa.criado_em)}` : 'nenhuma ainda', menor: true, ic: 'arquivo' }),
      kpi({ rotulo: 'Último retorno', valor: d.ultimo_retorno ? `${numero(d.ultimo_retorno.liquidados)} liquidados` : '—',
        apoio: d.ultimo_retorno ? `${d.ultimo_retorno.nome} · ${dataHora(d.ultimo_retorno.processado_em)}` : 'nenhum ainda', menor: true, tom: 'positivo', ic: 'ok' }),
      kpi({ rotulo: 'Arquivos na pasta de entrada', valor: numero(d.retornos_na_fila),
        apoio: 'processados na próxima varredura', menor: true, ic: 'relogio' })),

    el('div', { style: 'margin-top:14px' }, cartao('Como a troca funciona',
      el('div', {},
        el('p', { style: 'color:var(--texto-2);font-size:13px;margin-bottom:12px' },
          'Os títulos emitidos entram numa remessa e o arquivo é escrito na pasta de saída. A pasta de entrada é varrida de tempos em tempos e cada retorno novo é aplicado: entrada confirmada, liquidação (com o split na hora), baixa ou rejeição com o motivo. Ninguém gera nem importa arquivo na mão.'),
        el('div', { class: 'pares' },
          par('Pasta de saída (remessa)', el('code', { class: 'codigo' }, d.pasta_remessa)),
          par('Pasta de entrada (retorno)', el('code', { class: 'codigo' }, d.pasta_retorno)))),
      operar ? el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
        el('button', { class: 'botao', disabled: !d.aguardando_remessa.titulos, onclick: (e) => acao(e.currentTarget, async () => {
          const r = await api.post('/arquivos/remessas', {});
          toast(`Remessa ${r.nome} gerada com ${r.titulos} título(s).`, 'ok');
          recarregar();
        }) }, icone('baixar'), 'Gerar remessa agora'),
        el('button', { class: 'botao sec', onclick: (e) => acao(e.currentTarget, async () => {
          const r = await api.post('/arquivos/varrer', {});
          toast(r.arquivos ? `${r.arquivos} arquivo(s) processado(s).` : 'Nenhum retorno novo na pasta.', 'ok');
          recarregar();
        }) }, icone('atualizar'), 'Varrer a pasta agora'),
        el('button', { class: 'botao sec', onclick: enviarRetorno }, icone('importar'), 'Enviar retorno')) : null)),

    el('div', { class: 'grade duas', style: 'margin-top:14px' },
      cartao('Remessas enviadas', tabela({
        colunas: [
          { titulo: 'Arquivo', conteudo: (x) => el('span', {}, el('span', { class: 'forte num' }, x.nome),
            el('span', { class: 'sub' }, x.automatica ? 'automática' : `manual · ${x.criado_por_nome ?? '—'}`)) },
          { titulo: 'Quando', conteudo: (x) => dataHora(x.criado_em) },
          { titulo: 'Títulos', dir: true, conteudo: (x) => numero(x.titulos) },
          { titulo: 'Valor', dir: true, conteudo: (x) => dinheiro(x.valor_centavos) },
          { titulo: '', dir: true, conteudo: (x) => el('button', { class: 'botao sutil pequeno', onclick: (e) => acao(e.currentTarget, () => api.baixar(`/arquivos/remessas/${x.id}`, x.nome)) }, icone('baixar'), 'Baixar') },
        ],
        itens: d.remessas,
        vazio: 'Nenhuma remessa gerada ainda.',
      })),
      cartao('Retornos recebidos', tabela({
        colunas: [
          { titulo: 'Arquivo', conteudo: (x) => el('span', {}, el('span', { class: 'forte num' }, x.nome),
            el('span', { class: 'sub' }, `${x.origem === 'pasta' ? 'da pasta' : 'enviado à mão'}${x.credito_em ? ` · crédito ${data(x.credito_em)}` : ''}`)) },
          { titulo: 'Quando', conteudo: (x) => dataHora(x.criado_em) },
          { titulo: 'Resultado', conteudo: (x) => (x.erro
            ? el('span', {}, selo('erro', { erro: ['Recusado', 'erro'] }), el('span', { class: 'sub' }, x.erro))
            : el('span', {}, `${numero(x.liquidados)} liq. · ${numero(x.confirmados)} conf.`,
              x.rejeitados || x.sem_titulo || x.nao_tratados
                ? el('span', { class: 'sub', style: 'color:var(--vermelho)' },
                  [x.rejeitados ? `${x.rejeitados} rejeitado(s)` : null, x.sem_titulo ? `${x.sem_titulo} sem título` : null,
                    x.nao_tratados ? `${x.nao_tratados} não tratado(s)` : null].filter(Boolean).join(' · '))
                : null)) },
        ],
        itens: d.retornos,
        vazio: 'Nenhum retorno recebido ainda.',
        aoClicar: (x) => (x.detalhe || x.erro ? modal({ titulo: `Retorno ${x.nome}`, largo: true,
          corpo: el('div', { style: 'display:grid;gap:10px' },
            x.erro ? aviso(x.erro, 'erro') : null,
            x.detalhe ? el('div', {}, el('strong', {}, 'Registros que precisam de atenção'), el('div', { class: 'codigo' }, x.detalhe)) : null) }) : null),
      }))),
  );
}

// ---------------------------------------------------------------- Avisos por API (webhook)
async function abaEventos(alvo, query) {
  const p = { de: query.de ?? primeiroDiaMes(), ate: query.ate ?? hojeIso() };
  const d = await api.get(`/relatorios/conciliacao${qs(p)}`);
  const resumo = Object.fromEntries(d.resumo.map((r) => [r.resultado, r.n]));
  const form = el('form', { class: 'filtros', onsubmit: (e) => { e.preventDefault(); ir(`#/conciliacao${qs({ aba: 'eventos', ...lerForm(form) })}`); } },
    campo({ nome: 'de', rotulo: 'De', tipo: 'date', valor: p.de }),
    campo({ nome: 'ate', rotulo: 'Até', tipo: 'date', valor: p.ate }),
    el('button', { class: 'botao', type: 'submit' }, 'Filtrar'));

  const tom = { liquidado: 'ok', repetido: 'info', ignorado: 'neutra', erro: 'erro', pendente: 'aviso' };

  montar(alvo,
    el('div', { class: 'grade kpis' },
      kpi({ rotulo: 'Liquidados pelo aviso', valor: numero(resumo.liquidado ?? 0), tom: 'positivo', ic: 'ok' }),
      kpi({ rotulo: 'Avisos repetidos', valor: numero(resumo.repetido ?? 0), apoio: 'já estavam liquidados', menor: true, ic: 'atualizar' }),
      kpi({ rotulo: 'Ignorados', valor: numero(resumo.ignorado ?? 0), apoio: 'sem título correspondente', menor: true, ic: 'info' }),
      kpi({ rotulo: 'Com erro', valor: numero(resumo.erro ?? 0), menor: true, tom: (resumo.erro ?? 0) ? 'negativo' : '', ic: 'alerta' })),
    el('div', { style: 'margin-top:14px' }, form),
    d.sem_aviso ? aviso(`${d.sem_aviso} título(s) vencidos continuam em aberto. Se algum já foi pago, use "Consultar no banco" na ficha do boleto.`, 'aviso') : null,
    el('div', { style: 'margin-top:14px' }, tabela({
      colunas: [
        { titulo: 'Recebido', conteudo: (e) => dataHora(e.recebido_em) },
        { titulo: 'Evento', conteudo: (e) => el('span', {}, e.tipo, el('span', { class: 'sub' }, e.origem)) },
        { titulo: 'Nosso número', conteudo: (e) => el('span', { class: 'num' }, e.nosso_numero ?? '—') },
        { titulo: 'Título', conteudo: (e) => (e.boleto_id ? el('span', {}, e.pagador_nome, el('span', { class: 'sub' }, e.razao_social)) : '—') },
        { titulo: 'Valor', dir: true, conteudo: (e) => (e.valor_centavos ? dinheiro(e.valor_centavos) : '—') },
        { titulo: 'Resultado', conteudo: (e) => el('span', {}, el('span', { class: `selo ${tom[e.resultado ?? 'pendente'] ?? 'neutra'}` }, e.resultado ?? 'pendente'),
          e.erro ? el('span', { class: 'sub' }, e.erro) : null) },
      ],
      itens: d.eventos,
      vazio: 'Nenhum aviso recebido no período.',
      aoClicar: (e) => (e.boleto_id ? ir(`#/boletos/${e.boleto_id}`) : null),
    })),
  );
}
