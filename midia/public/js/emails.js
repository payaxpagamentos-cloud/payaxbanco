/**
 * A caixa de entrada do CRM.
 *
 * O e-mail do cliente deixa de morrer na caixa pessoal de quem atendeu: ele chega aqui, fica ligado ao
 * lead e qualquer um da equipe continua a conversa de onde parou. A resposta sai daqui e entra no
 * histórico do funil, junto com as ligações e as visitas.
 *
 * A mensagem é mostrada **em texto**. Não renderizamos o HTML de quem escreveu, de propósito: e-mail de
 * origem desconhecida é a porta de entrada mais comum de golpe, e nada que veio de fora precisa rodar
 * dentro do painel. Quem quiser ver exatamente como chegou baixa o original (.eml).
 */
import { api, qs, baixar } from './api.js';
import {
  el, limpar, icone, toast, acao, modal, formModal, campo, escolha, area, inteiro, dataHora, etiqueta, repetir,
} from './ui.js';
import { cartao, indicador, tabela, vazio } from './comum.js';

const CAIXAS = { entrada: 'Caixa de entrada', meus: 'Meus e-mails', nao_lidos: 'Não lidos', enviados: 'Enviados', arquivados: 'Arquivados' };
const TIPOS_LEAD = { anunciante: 'Quer anunciar', ponto: 'Quer tela no espaço dele' };
const tamanho = (b) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round((b ?? 0) / 1024))} kB`);
const quem = (e) => (e.de_nome ? `${e.de_nome} <${e.de}>` : e.de);

export async function emails(ctx) {
  const estado = { caixa: 'entrada', busca: '' };
  const corpo = el('div', { class: 'coluna' });

  const pintar = async () => {
    const d = await api.get(`/painel/crm/emails${qs({ caixa: estado.caixa, busca: estado.busca })}`);
    const t = d.totais;
    limpar(corpo,
      avisoDoServidor(d.servidor),
      el('div', { class: 'grade' },
        indicador({
          rotulo: 'Não lidos', valor: inteiro(t.nao_lidos), ic: 'aprovacoes', cor: t.nao_lidos ? 'azul' : 'verde',
          nota: `${inteiro(t.na_caixa)} na caixa de entrada`,
        }),
        indicador({
          rotulo: 'Sem resposta', valor: inteiro(t.sem_resposta), ic: 'relogio', cor: t.sem_resposta ? 'laranja' : 'verde',
          nota: t.sem_resposta ? 'alguém escreveu e ainda não teve retorno' : 'ninguém esperando',
        }),
        indicador({
          rotulo: 'Sem lead', valor: inteiro(t.sem_vinculo), ic: 'anunciantes', cor: 'ciano',
          nota: 'mensagens que ainda não estão no funil',
        }),
        indicador({ rotulo: 'Enviados', valor: inteiro(t.enviados), ic: 'enviar', cor: 'verde', nota: 'respostas que saíram daqui' })),

      cartao(CAIXAS[estado.caixa], d.itens.length
        ? tabela([
          [(e) => el('div', {},
            el('div', {}, el('strong', { style: e.lido_em ? '' : 'font-weight:800' }, e.direcao === 'saida' ? `Para ${e.para}` : quem(e))),
            el('div', { class: 'pequeno mudo' }, e.assunto)), 'De / assunto'],
          [(e) => el('div', { class: 'pequeno mudo' }, e.previa || '—'), 'Mensagem'],
          [(e) => (e.lead
            ? etiqueta(e.lead, 'info')
            : (e.anunciante ? etiqueta(e.anunciante, 'ok') : (e.ponto ? etiqueta(e.ponto, 'ok') : el('span', { class: 'mudo pequeno' }, 'sem vínculo')))), 'No funil'],
          [(e) => el('div', { class: 'linha', style: 'gap:6px' },
            e.anexos ? etiqueta(`${e.anexos} anexo(s)`) : null,
            e.direcao === 'entrada' && !e.lido_em ? etiqueta('Novo', 'aviso') : null), 'Estado'],
          [(e) => dataHora(e.recebido_em), 'Quando', 'num dir'],
        ], d.itens, { aoClicar: (e) => abrir(e.id, pintar) })
        : vazio(estado.caixa === 'entrada'
          ? 'Nenhuma mensagem na caixa. Quando alguém escrever para um endereço da empresa, ela aparece aqui.'
          : 'Nada por aqui.')));
  };

  const barra = el('div', { class: 'filtros livre' },
    escolha('Caixa', 'caixa', CAIXAS, estado.caixa, { onchange: (e) => { estado.caixa = e.target.value; pintar(); } }),
    campo('Buscar', {
      placeholder: 'Remetente, assunto, trecho…',
      oninput: (e) => { estado.busca = e.target.value; clearTimeout(barra.t); barra.t = setTimeout(pintar, 350); },
    }),
    el('button', { class: 'btn primario', onclick: () => escrever(null, pintar) }, icone('enviar'), 'Escrever'));

  limpar(ctx.conteudo, barra, corpo);
  await pintar();
  // A caixa se atualiza sozinha: ninguém fica apertando F5 esperando o cliente responder.
  ctx.parar(repetir(pintar, 60_000));
}

/** O estado do servidor de e-mail, em português claro, só quando há algo a dizer. */
function avisoDoServidor(s) {
  if (!s.configurado) {
    return el('p', { class: 'aviso' },
      'O servidor de e-mail ainda não está ligado: nenhum domínio configurado em MIDIA_EMAIL_DOMINIOS. '
      + 'Enquanto isso, a caixa mostra só o que sai daqui. O README explica o que o domínio precisa ter (MX, SPF e DKIM).');
  }
  if (!s.ouvindo) {
    return el('p', { class: 'aviso erro' },
      `O servidor de e-mail está configurado para ${s.dominios.join(', ')}, mas não subiu${s.erro ? `: ${s.erro}` : ''}. `
      + 'Enquanto isso, nada novo entra na caixa.');
  }
  if (!s.envio) {
    return el('p', { class: 'aviso' },
      'Está recebendo normalmente, mas o envio não está ligado no servidor: dá para ler, não dá para responder.');
  }
  return null;
}

/**
 * Separa o que a pessoa escreveu agora do que veio citado da mensagem anterior (as linhas com ">" e o
 * cabeçalho "Em tal dia, fulano escreveu:"). O novo aparece limpo; o citado fica recolhido.
 */
function separarCitacao(texto) {
  const linhas = String(texto ?? '').split('\n');
  let corte = linhas.findIndex((l) => /^\s*>/.test(l));
  // Programa que não põe ">" marca a citação com uma linha de cabeçalho.
  if (corte < 0) corte = linhas.findIndex((l) => /^(Em .+ escreveu:|On .+ wrote:|-{2,}\s*(Mensagem original|Original Message)\s*-{2,})\s*$/i.test(l.trim()));
  if (corte < 0) return { novo: String(texto ?? '').trim(), citado: '' };
  // O cabeçalho ("Em ..., fulano escreveu:") pode vir sem ">" logo acima, em até três linhas.
  for (let i = corte - 1; i >= Math.max(0, corte - 4); i--) {
    if (/(escreveu|wrote):\s*$/i.test(linhas[i])) {
      let ini = i;
      while (ini > 0 && ini > i - 2 && linhas[ini - 1].trim() && !/^(Em|On) /i.test(linhas[ini])) ini--;
      corte = ini;
      break;
    }
    if (linhas[i].trim()) break;
  }
  const citado = linhas.slice(corte).map((l) => l.replace(/^\s*>\s?/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { novo: linhas.slice(0, corte).join('\n').trim(), citado };
}

function corpoDaMensagem(texto) {
  const { novo, citado } = separarCitacao(texto);
  return el('div', { class: 'leitura-email' },
    el('div', { class: 'corpo-email' }, novo || (citado ? '(sem texto novo)' : '(mensagem sem texto)')),
    citado ? el('details', { class: 'citacao-email' },
      el('summary', {}, 'Ver a mensagem anterior'),
      el('div', { class: 'corpo-email citado' }, citado)) : null);
}

/** A mensagem aberta: o texto, os anexos e o que fazer com ela. */
async function abrir(id, recarregar) {
  const e = await api.get(`/painel/crm/emails/${id}`);
  await modal(e.assunto || '(sem assunto)', (fechar) => {
    const acoes = el('div', { class: 'linha', style: 'margin-top:14px;gap:8px;flex-wrap:wrap' });

    const fecharE = async (fn) => { await fn(); fechar(); await recarregar(); };
    if (e.direcao === 'entrada') {
      acoes.append(
        el('button', { class: 'btn primario', onclick: () => { fechar(); escrever(e, recarregar); } }, icone('enviar'), 'Responder'),
        el('button', {
          class: 'btn',
          onclick: (ev) => acao(ev.target, () => fecharE(async () => {
            await api.post(`/painel/crm/emails/${e.id}/arquivar`, { arquivado: !e.arquivado_em });
            toast(e.arquivado_em ? 'De volta para a caixa.' : 'Arquivado.');
          })),
        }, icone(e.arquivado_em ? 'entrar' : 'ok'), e.arquivado_em ? 'Voltar para a caixa' : 'Arquivar'),
        e.lead_id
          ? el('button', { class: 'btn', onclick: (ev) => acao(ev.target, () => fecharE(() => desvincular(e))) }, 'Desligar do lead')
          : el('button', { class: 'btn', onclick: () => { fechar(); ligarAoFunil(e, recarregar); } }, icone('anunciantes'), 'Ligar ao funil'));
    }
    acoes.append(el('button', {
      class: 'btn pequeno',
      onclick: (ev) => acao(ev.target, () => baixar(`/painel/crm/emails/${e.id}/original`, `mensagem-${e.id}.eml`)),
    }, icone('baixar'), 'Original (.eml)'));

    return [
      el('div', { class: 'dados dados-email', style: 'margin-bottom:14px' },
        el('div', {}, el('span', { class: 'rotulo' }, 'De'), el('span', {}, quem(e))),
        el('div', {}, el('span', { class: 'rotulo' }, 'Para'), el('span', {}, e.para)),
        el('div', {}, el('span', { class: 'rotulo' }, 'Quando'), el('span', {}, dataHora(e.recebido_em))),
        el('div', {}, el('span', { class: 'rotulo' }, 'No funil'),
          el('span', {}, e.lead ?? e.anunciante ?? e.ponto ?? 'sem vínculo'))),

      corpoDaMensagem(e.texto),

      e.anexos.length
        ? el('div', { style: 'margin-top:14px' },
          el('h3', {}, 'Anexos'),
          el('div', { class: 'linha', style: 'gap:8px;flex-wrap:wrap' }, e.anexos.map((a) => el('button', {
            class: 'btn pequeno',
            onclick: (ev) => acao(ev.target, () => baixar(`/painel/crm/emails/${e.id}/anexo/${a.indice}`, a.nome)),
          }, icone('baixar'), `${a.nome} · ${tamanho(a.tamanho)}`))))
        : null,

      e.conversa.length
        ? el('div', { style: 'margin-top:16px' },
          el('h3', {}, 'Nesta conversa'),
          el('ul', { class: 'linha-tempo' }, e.conversa.map((c) => el('li', {},
            el('div', { class: 'quando' }, dataHora(c.recebido_em)),
            el('div', {}, el('strong', {}, c.direcao === 'saida' ? 'Nós respondemos' : quem(c)),
              el('div', { class: 'pequeno mudo' }, c.previa || c.assunto))))))
        : null,

      acoes,
    ];
  }, { largo: true });
}

const desvincular = async (e) => {
  await api.post(`/painel/crm/emails/${e.id}/lead`, { lead_id: null });
  toast('Mensagem desligada do lead.');
};

/** Ligar ao funil: ou a um lead que já existe, ou criando um a partir de quem escreveu. */
async function ligarAoFunil(e, recarregar) {
  const funil = await api.get('/painel/crm/funil');
  const leads = funil.etapas.flatMap((c) => c.itens).map((l) => [l.id, `${l.nome}${l.cidade ? ` — ${l.cidade}` : ''}`]);
  const feito = await formModal('Ligar ao funil', () => [
    el('p', { class: 'mudo pequeno', style: 'margin:0' },
      `Quem escreveu foi ${quem(e)}. Ligue a um lead que já existe ou crie um novo com estes dados.`),
    escolha('Lead existente', 'lead_id', { '': 'Criar um lead novo…', ...Object.fromEntries(leads) }, ''),
    escolha('Se for novo, que tipo?', 'tipo', TIPOS_LEAD, 'anunciante'),
  ], async (d) => {
    if (d.lead_id) {
      await api.post(`/painel/crm/emails/${e.id}/lead`, { lead_id: Number(d.lead_id) });
      return 'ligado';
    }
    const r = await api.post(`/painel/crm/emails/${e.id}/virar-lead`, { tipo: d.tipo });
    return r.lead_id ? 'novo' : 'ligado';
  }, { rotulo: 'Ligar' });
  if (feito) {
    toast(feito === 'novo' ? 'Lead criado e conversa ligada a ele.' : 'Mensagem ligada ao lead.');
    await recarregar();
  }
}

/** Escrever ou responder. Sem `responder`, é mensagem nova — `para` e `lead_id` já vêm prontos do lead. */
async function escrever(responder, recarregar, { para = '', lead_id = null } = {}) {
  const assuntoPadrao = responder ? `Re: ${String(responder.assunto).replace(/^(re:\s*)+/i, '')}` : '';
  const citacao = responder
    ? `\n\n---\nEm ${dataHora(responder.recebido_em)}, ${quem(responder)} escreveu:\n`
      + String(responder.texto ?? '').split('\n').slice(0, 40).map((l) => `> ${l}`).join('\n')
    : '';
  const enviado = await formModal(responder ? 'Responder' : 'Nova mensagem', () => [
    campo('Para', { name: 'para', type: 'email', required: true, value: responder?.de ?? para, placeholder: 'cliente@empresa.com.br' }),
    campo('Assunto', { name: 'assunto', maxlength: 200, value: assuntoPadrao, placeholder: 'Sobre a proposta…' }),
    area('Mensagem', { name: 'texto', required: true, rows: 10, style: 'min-height:200px' }, citacao),
    el('p', { class: 'mudo pequeno', style: 'margin:0' },
      'Sai pelo e-mail da empresa e fica guardado aqui, no histórico do lead.'),
  ], async (d) => api.post('/painel/crm/emails', {
    para: d.para,
    assunto: d.assunto,
    texto: d.texto,
    responder_a: responder?.id ?? null,
    lead_id: responder?.lead_id ?? lead_id,
  }), { rotulo: 'Enviar', largo: true });

  if (enviado) {
    toast('Mensagem enviada.');
    await recarregar();
  }
}

/** Os e-mails de um lead, para mostrar dentro da ficha dele. */
export const emailsDoLead = (leadId) => api.get(`/painel/crm/emails${qs({ lead_id: leadId, caixa: 'tudo' })}`);

export { abrir as abrirEmail, escrever as escreverEmail };
