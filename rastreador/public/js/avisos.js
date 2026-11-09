/** Avisos da empresa: contatos do WhatsApp (quem recebe o quê, com horário de silêncio) e os relatórios programados em PDF. */
import { api } from './api.js';
import { el, limpar, dataHora, telefone, toast, campo, marcar, formModal, confirmar, repetir, etiqueta, icone } from './ui.js';
import { cartao, tabela, td, botao, botaoIcone, acoesTopo } from './comum.js';

const base = (ctx) => `/empresas/${ctx.empresaId}`;
const pode = (ctx) => !ctx.somenteLeitura;
const STATUS_MSG = { pendente: ['na fila', 'aviso'], enviada: ['enviada', 'ok'], falhou: ['falhou', 'erro'] };
const STATUS_ENVIO = { falhou: 'falhou', sem_destino: 'sem contato', sem_whatsapp: 'WhatsApp desligado' };
const numeroLeitura = (n) => (String(n ?? '').startsWith('55') ? telefone(String(n).slice(2)) : n);
const semWhatsapp = () => el('p', { class: 'aviso' }, 'O WhatsApp ainda não foi ligado no servidor: os contatos ficam salvos e os avisos começam a sair assim que o suporte ligar.');

// ---------- Notificações ----------
async function telaNotificacoes(ctx) {
  const corpo = el('div', { class: 'coluna', style: 'gap:16px' });
  let dados = null;
  const form = async (c) => {
    if (!dados) return toast('Aguarde o carregamento.', true);
    const marcados = new Set(c ? c.tipos.split(',') : dados.seguranca);
    const r = await formModal(c ? `Editar ${c.nome}` : 'Novo contato do WhatsApp', () => [
      el('div', { class: 'duas' }, campo('Nome', { name: 'nome', required: true, maxlength: 80, value: c?.nome ?? '' }),
        campo('WhatsApp (com DDD)', { name: 'numero', required: true, inputmode: 'tel', value: c ? numeroLeitura(c.numero) : '', placeholder: '(11) 99999-0000' })),
      el('fieldset', { class: 'tipos-aviso' }, el('legend', {}, 'Avisos que recebe'),
        el('div', { class: 'grade-marcar' }, Object.entries(dados.tipos).map(([k, rot]) => el('label', { class: `marcar${dados.seguranca.includes(k) ? ' seg' : ''}` },
          el('input', { type: 'checkbox', name: `tipo_${k}`, checked: marcados.has(k) || null }), rot,
          dados.seguranca.includes(k) ? el('span', { class: 'pequeno fraco' }, ' · segurança') : null)))),
      el('div', { class: 'duas' }, campo('Silêncio a partir de (opcional)', { name: 'silencio_inicio', type: 'time', value: c?.silencio_inicio ?? '' }),
        campo('Silêncio até', { name: 'silencio_fim', type: 'time', value: c?.silencio_fim ?? '' })),
      el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'No silêncio só chegam os avisos de segurança (roubo, estacionado violado, sumiço, pânico, bateria desconectada, violação e liberação).'),
      c ? marcar('Ativo', { name: 'ativo', checked: Boolean(c.ativo) }) : null,
    ], (d) => {
      const tipos = Object.keys(dados.tipos).filter((k) => d[`tipo_${k}`]);
      const corpoReq = { nome: d.nome, numero: d.numero, tipos, silencio_inicio: d.silencio_inicio, silencio_fim: d.silencio_fim, ativo: d.ativo };
      return c ? api.put(`${base(ctx)}/contatos/${c.id}`, corpoReq) : api.post(`${base(ctx)}/contatos`, corpoReq);
    }, { largo: true });
    if (r) { toast('Contato salvo.'); carregar(); }
  };
  const novo = pode(ctx) ? el('button', { class: 'btn primario', onclick: () => form(null) }, icone('alertas'), 'Novo contato') : null;
  limpar(ctx.conteudo, acoesTopo(el('p', { class: 'mudo', style: 'margin:0;max-width:720px' },
    'Quem recebe os avisos pelo WhatsApp e quais. Os avisos de segurança chegam a qualquer hora; os outros respeitam o horário de silêncio de cada contato.'), novo), corpo);
  async function carregar() {
    dados = await api.get(`${base(ctx)}/notificacoes`);
    limpar(corpo,
      dados.whatsapp ? null : semWhatsapp(),
      cartao('Contatos', tabela(['Nome', 'WhatsApp', 'Avisos', 'Silêncio', 'Situação', '^Ações'], dados.contatos.map((c) => {
        const tipos = c.tipos.split(',').filter(Boolean);
        return el('tr', { class: c.ativo ? '' : 'inativo' },
          td(el('strong', {}, c.nome)), td(numeroLeitura(c.numero)),
          td(el('div', { class: 'etiquetas' }, tipos.slice(0, 4).map((t) => etiqueta(dados.tipos[t] ?? t, dados.seguranca.includes(t) ? 'erro' : 'info')),
            tipos.length > 4 ? el('span', { class: 'pequeno mudo' }, `+${tipos.length - 4}`) : null)),
          td(c.silencio_inicio ? `${c.silencio_inicio} às ${c.silencio_fim}` : '—'), td(c.ativo ? etiqueta('ativo', 'ok') : etiqueta('inativo', '')),
          el('td', { class: 'acoes' }, pode(ctx) ? [
            botao('Testar', '', async () => { await api.post(`${base(ctx)}/contatos/${c.id}/testar`, {}); toast('Mensagem de teste na fila.'); setTimeout(() => corpo.isConnected && carregar(), 3000); }),
            botaoIcone('editar', 'Editar', () => form(c)),
            botaoIcone('lixo', 'Excluir', async () => {
              if (!await confirmar('Excluir contato', `${c.nome} deixa de receber os avisos.`, 'Excluir')) return;
              await api.del(`${base(ctx)}/contatos/${c.id}`);
              carregar();
            }, 'perigo')] : null));
      }), 'Nenhum contato. Cadastre quem deve receber os avisos de segurança.')),
      cartao('Últimas mensagens', tabela(['Quando', 'Para', 'Mensagem', 'Situação'], dados.mensagens.map((m) => {
        const [rot, tom] = STATUS_MSG[m.status] ?? [m.status, ''];
        return el('tr', {}, td(dataHora(m.enviado_em ?? m.criado_em)), td(numeroLeitura(m.numero)),
          td([el('div', { class: 'pequeno texto-msg' }, m.texto), m.arquivo_nome ? el('div', { class: 'pequeno mudo' }, `anexo: ${m.arquivo_nome}`) : null]),
          td([etiqueta(rot, tom), m.erro ? el('div', { class: 'pequeno mudo' }, m.erro) : m.tentativas > 1 ? el('div', { class: 'pequeno mudo' }, `${m.tentativas} tentativas`) : null]));
      }), 'Nenhuma mensagem enviada ainda.')));
  }
  ctx.parar(repetir(carregar, 30_000));
}

// ---------- Relatórios programados ----------
async function telaProgramados(ctx) {
  const corpo = el('div', { class: 'coluna', style: 'gap:16px' });
  let dados = null;
  const form = async (a) => {
    if (!dados) return toast('Aguarde o carregamento.', true);
    if (!dados.contatos.length) return toast('Cadastre antes um contato em Configurações → Notificações.', true);
    const conteudo = new Set(a ? a.conteudo.split(',') : Object.keys(dados.conteudos));
    const contatos = new Set(a ? a.contatos.split(',').map(Number) : [dados.contatos[0].id]);
    const r = await formModal(a ? `Editar ${a.nome}` : 'Novo relatório programado', () => [
      campo('Nome', { name: 'nome', maxlength: 80, value: a?.nome ?? '', placeholder: 'Ex.: Resumo semanal da diretoria' }),
      el('fieldset', {}, el('legend', {}, 'Frequência'), el('div', { class: 'opcoes-radio' }, Object.entries(dados.frequencias).map(([k, rot]) => el('label', { class: 'radio' },
        el('input', { type: 'radio', name: 'frequencia', value: k, checked: (a?.frequencia ?? 'semanal') === k || null }), el('span', {}, rot))))),
      el('fieldset', {}, el('legend', {}, 'Conteúdo do PDF'), el('div', { class: 'grade-marcar' }, Object.entries(dados.conteudos).map(([k, rot]) => el('label', { class: 'marcar' },
        el('input', { type: 'checkbox', name: `c_${k}`, checked: conteudo.has(k) || null }), rot)))),
      el('fieldset', {}, el('legend', {}, 'Enviar para'), el('div', { class: 'grade-marcar' }, dados.contatos.map((c) => el('label', { class: 'marcar' },
        el('input', { type: 'checkbox', name: `p_${c.id}`, checked: contatos.has(c.id) || null }), `${c.nome} · ${numeroLeitura(c.numero)}`)))),
      a ? marcar('Ativo', { name: 'ativo', checked: Boolean(a.ativo) }) : null,
      el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'Sai às 7h: diário (o dia anterior), semanal (segunda, a semana anterior), quinzenal (dias 1 e 16) e mensal (dia 1, o mês anterior).'),
    ], (d) => {
      const corpoReq = {
        nome: d.nome || undefined, frequencia: d.frequencia, ativo: d.ativo,
        conteudo: Object.keys(dados.conteudos).filter((k) => d[`c_${k}`]), contatos: dados.contatos.filter((c) => d[`p_${c.id}`]).map((c) => c.id),
      };
      return a ? api.put(`${base(ctx)}/relatorios-programados/${a.id}`, corpoReq) : api.post(`${base(ctx)}/relatorios-programados`, corpoReq);
    }, { largo: true });
    if (r) { toast('Relatório programado salvo.'); carregar(); }
  };
  const novo = pode(ctx) ? el('button', { class: 'btn primario', onclick: () => form(null) }, icone('relatorios'), 'Novo relatório programado') : null;
  limpar(ctx.conteudo, acoesTopo(el('p', { class: 'mudo', style: 'margin:0;max-width:720px' },
    'Relatórios em PDF que chegam sozinhos pelo WhatsApp, com um resumo em texto na mensagem.'), novo), corpo);
  async function carregar() {
    dados = await api.get(`${base(ctx)}/relatorios-programados`);
    const nomeContato = new Map(dados.contatos.map((c) => [c.id, c.nome]));
    limpar(corpo,
      dados.whatsapp ? null : semWhatsapp(),
      cartao('Agendados', tabela(['Nome', 'Frequência', 'Conteúdo', 'Para', 'Próximo envio', '^Ações'], dados.agendas.map((a) => el('tr', { class: a.ativo ? '' : 'inativo' },
        td(el('strong', {}, a.nome)), td(dados.frequencias[a.frequencia] ?? a.frequencia),
        td(a.conteudo.split(',').map((c) => dados.conteudos[c] ?? c).join(', ')),
        td(a.contatos.split(',').map((id) => nomeContato.get(Number(id)) ?? '—').join(', ')),
        td(a.ativo ? dataHora(a.proximo_em) : etiqueta('pausado', '')),
        el('td', { class: 'acoes' }, pode(ctx) ? [
          botao('Enviar agora', '', async () => {
            const r = await api.post(`${base(ctx)}/relatorios-programados/${a.id}/enviar`, {});
            toast(r?.status === 'enviado' ? `Relatório na fila do WhatsApp para ${r.destinos} contato(s).` : `Não foi: ${r?.erro ?? 'erro no envio'}`, r?.status !== 'enviado');
            carregar();
          }),
          botaoIcone('editar', 'Editar', () => form(a)),
          botaoIcone('lixo', 'Excluir', async () => {
            if (!await confirmar('Excluir agendamento', `"${a.nome}" deixa de ser enviado.`, 'Excluir')) return;
            await api.del(`${base(ctx)}/relatorios-programados/${a.id}`);
            carregar();
          }, 'perigo')] : null))), 'Nenhum relatório programado.')),
      cartao('Envios', tabela(['Quando', 'Relatório', 'Período', 'Situação'], dados.envios.map((x) => el('tr', {},
        td(dataHora(x.criado_em)), td(x.nome), td(`${x.de.split('-').reverse().join('/')} a ${x.ate.split('-').reverse().join('/')}`),
        td(x.status === 'enviado' ? etiqueta(`enviado a ${x.destinos} contato(s)`, 'ok') : [etiqueta(STATUS_ENVIO[x.status] ?? x.status, 'erro'), el('div', { class: 'pequeno mudo' }, x.erro ?? '')]))),
      'Nenhum envio ainda.')));
  }
  await carregar();
}

export const TELAS_AVISOS = { notificacoes: telaNotificacoes, programados: telaProgramados };
