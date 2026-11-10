/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/
/** App do cliente (usuário final): entra com e-mail ou CPF + senha e acompanha o veículo ao vivo, o plano, os seguros e o atendimento. */
import { BASE } from '../js/api.js';
import { el, limpar, dinheiro } from '../js/ui.js';

const raiz = document.getElementById('app');
const CHAVE = 'rastreador.cliente';
const ler = () => { try { return JSON.parse(localStorage.getItem(CHAVE)); } catch { return null; } };
const gravar = (v) => { try { if (v === null) localStorage.removeItem(CHAVE); else localStorage.setItem(CHAVE, JSON.stringify(v)); } catch { /* sem armazenamento */ } };
let sessao = ler();
let painelDados = null;
let timer = null;

const ico = (d, fill = false) => el('svg', { viewBox: '0 0 24 24',
  ...(fill ? { fill: 'currentColor' } : { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }) },
  el('path', { d }));

const IC = {
  radar: 'M19.07 4.93A10 10 0 0 0 6.99 3.34M4 6h.01M2.29 9.62A10 10 0 1 0 21.31 8.35M16.24 7.76A6 6 0 1 0 8.23 16.67M12 18h.01M17.99 11.66A6 6 0 0 1 15.77 16.67M14 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM13.41 10.59l5.66-5.66',
  carro: 'M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2M14 9h4l3 3v5a1 1 0 0 1-1 1h-1M8 19a2 2 0 1 0 4 0 2 2 0 0 0-4 0zM16 19a2 2 0 1 0 4 0 2 2 0 0 0-4 0z',
  mapa: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14',
  grafico: 'M3 3v18h18M7 15l4-4 3 3 6-6',
  seguro: 'M3 12a9 9 0 0 1 18 0ZM12 12v6a3 3 0 0 0 5 0M12 2v2',
  bandeira: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z',
  chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  whats: 'M12 2a10 10 0 0 0-8.5 15.3L2 22l4.8-1.5A10 10 0 1 0 12 2zm0 2a8 8 0 1 1-4.2 14.8l-.3-.2-2.8.9.9-2.7-.2-.3A8 8 0 0 1 12 4zm4.3 10.1c-.2-.1-1.3-.7-1.5-.8-.2-.1-.4-.1-.5.1l-.7.9c-.1.2-.3.2-.5.1a6.5 6.5 0 0 1-3.2-2.8c-.1-.2 0-.4.1-.5l.4-.5c.1-.2.1-.3 0-.5l-.7-1.6c-.2-.4-.3-.3-.5-.3h-.4c-.2 0-.4.1-.6.3-.7.7-.9 1.7-.6 2.7.5 1.6 1.6 2.9 3.1 3.8 1 .6 1.8.9 2.8.9.4 0 1 0 1.5-.5.3-.3.5-.8.5-1.2 0-.1 0-.3-.2-.4z',
  tel: 'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.6A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z',
  sino: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  doc: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 13h6M9 17h6',
  casa: 'M3 11l9-8 9 8M5 10v10h14V10',
  user: 'M20 21a8 8 0 0 0-16 0M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  cadeado: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  mais: 'M12 5v14M5 12h14',
  relogio: 'M12 7v5l3 3M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  sair: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
};

const SITUACAO = {
  movimento: ['● Em movimento', 'ok'], ligado: ['● Ligado parado', 'aviso'], parado: ['● Parado', 'neutro'],
  sem_sinal: ['● Sem sinal', 'erro'], sem_posicao: ['● Sem posição', 'neutro'], sem_rastreador: ['Sem rastreador', 'neutro'], inativo: ['Inativo', 'neutro'],
};
const STATUS_SEG = {
  emitida: ['✓ Apólice emitida', 'ok'], pendente: ['● Em análise', 'pend'], enviada: ['● Em emissão', 'pend'], recusada: ['Recusada', 'neutro'],
};
const dataBR = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const soDigitos = (s) => String(s ?? '').replace(/\D/g, '');

async function chamar(metodo, caminho, corpo) {
  let resp;
  try {
    resp = await fetch(`${BASE}/api/usuario${caminho}`, {
      method: metodo,
      headers: { ...(corpo ? { 'Content-Type': 'application/json' } : {}), ...(sessao?.token ? { Authorization: `Bearer ${sessao.token}` } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
  } catch { throw new Error('Sem internet agora. Tente de novo.'); }
  if (resp.status === 401 && caminho !== '/login') { sair(); throw new Error('Sua sessão terminou. Entre de novo.'); }
  const r = resp.status === 204 ? null : await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(r?.erro || `Erro ${resp.status}`);
  return r;
}

function toast(msg, erro = false) {
  const t = el('div', { class: `toast${erro ? ' erro' : ''}` }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
}

function sair() {
  sessao = null; gravar(null); clearInterval(timer); painelDados = null;
  entrar();
}

const marca = (claro = false) => el('div', { class: 'marca' },
  el('span', { class: 'ic' }, ico(IC.radar)), el('span', {}, claro ? 'Rastreador' : 'Rastreador'));

// ---------- Login ----------
function entrar() {
  const campoId = el('input', { type: 'text', inputmode: 'email', autocomplete: 'username', placeholder: 'e-mail ou CPF' });
  const campoSenha = el('input', { type: 'password', autocomplete: 'current-password', placeholder: 'sua senha' });
  const aviso = el('div');
  const botao = el('button', { class: 'btn', type: 'submit' }, 'Entrar');
  const form = el('form', { class: 'login', onsubmit: async (e) => {
    e.preventDefault();
    limpar(aviso);
    botao.disabled = true; botao.textContent = 'Entrando…';
    try {
      const r = await chamar('POST', '/login', { identificador: campoId.value.trim(), senha: campoSenha.value });
      sessao = { token: r.token, nome: r.usuario.nome }; gravar(sessao);
      inicio();
    } catch (err) {
      aviso.append(el('div', { class: 'aviso' }, err.message));
      botao.disabled = false; botao.textContent = 'Entrar';
    }
  } },
    marca(true),
    el('h1', {}, 'Minha conta'),
    el('p', { class: 'sub' }, 'Acompanhe o seu veículo, o plano e os seguros.'),
    aviso,
    el('label', { class: 'campo' }, el('span', {}, 'E-mail ou CPF'), campoId),
    el('label', { class: 'campo' }, el('span', {}, 'Senha'), campoSenha),
    botao,
    el('div', { class: 'rod' }, 'Acesso fornecido pela empresa que cuida do seu rastreamento.'));
  limpar(raiz, form);
}

// ---------- Início ----------
async function inicio() {
  limpar(raiz, el('p', { class: 'carregando-app', role: 'status' }, 'Carregando…'));
  try {
    painelDados = await chamar('GET', '/painel');
  } catch (err) {
    limpar(raiz, el('p', { class: 'carregando-app' }, err.message));
    return;
  }
  render();
  clearInterval(timer);
  timer = setInterval(async () => {
    if (document.visibilityState !== 'visible') return;
    try { painelDados = await chamar('GET', '/painel'); render(); } catch { /* mantém a tela */ }
  }, 30000);
}

function render() {
  const d = painelDados;
  const primeiroNome = (d.usuario.nome || '').split(' ')[0];
  const cab = el('div', { class: 'cab' },
    el('div', { class: 'topo' }, marca(),
      el('button', { class: 'avatar', title: 'Sair', onclick: () => { if (confirm('Sair da conta?')) sair(); } }, iniciais(d.usuario.nome))),
    el('div', { class: 'ola' }, `Olá, ${primeiroNome} 👋`, el('small', {}, `${d.usuario.empresa} · acompanhe o seu veículo e serviços`)));

  const corpo = el('div', { class: 'corpo' },
    ...d.veiculos.map(cardVeiculo),
    d.veiculos.length ? null : el('div', { class: 'card' }, el('div', { class: 'vazio' }, ico(IC.carro), el('div', {}, 'Nenhum veículo vinculado à sua conta ainda.'))),
    cardPlano(d.plano),
    cardSeguros(d.seguros),
    cardAtendimento(d.atendimento));

  limpar(raiz, cab, corpo, navInferior());
  scrollTo(0, 0);
}

const iniciais = (n) => (n || '?').split(' ').filter(Boolean).slice(0, 2).map((x) => x[0]).join('').toUpperCase();

function cardVeiculo(v) {
  const [rot, cls] = v.bloqueado ? ['● Bloqueado', 'erro'] : (SITUACAO[v.situacao] || ['—', 'neutro']);
  const temPos = Number.isFinite(v.lat) && Number.isFinite(v.lng) && !(v.lat === 0 && v.lng === 0);
  return el('div', { class: 'card' }, el('div', { class: 'pad' },
    el('div', { class: 'veic-top' },
      el('div', {}, el('div', { class: 'placa' }, formataPlaca(v.placa)),
        el('div', { class: 'veic-sub' }, [v.descricao, v.modelo].filter(Boolean).join(' · ') || 'Veículo')),
      el('span', { class: `chip ${cls}` }, rot)),
    el('div', { class: 'stats' },
      stat(v.velocidade_kmh != null ? `${Math.round(v.velocidade_kmh)} km/h` : '—', 'Velocidade'),
      stat(v.ignicao ? 'Ligada' : 'Desligada', 'Ignição'),
      stat(v.tensao != null ? `${Number(v.tensao).toFixed(1)} V` : '—', 'Bateria')),
    el('div', { class: 'veic-sub', style: 'margin-top:10px' }, `Última posição: ${dataBR(v.posicao_em)}`),
    temPos
      ? el('a', { class: 'btn', href: `https://www.google.com/maps?q=${v.lat},${v.lng}`, target: '_blank', rel: 'noopener' }, ico(IC.mapa), 'Ver no mapa')
      : el('button', { class: 'btn', disabled: true }, ico(IC.mapa), 'Sem posição no momento')));
}

const stat = (v, l) => el('div', { class: 'stat' }, el('div', { class: 'v' }, v), el('div', { class: 'l' }, l));

function cardPlano(p) {
  return el('div', { class: 'card' }, el('div', { class: 'pad' },
    el('div', { class: 'rot' }, ico(IC.grafico), 'Plano contratado'),
    el('div', { style: 'display:flex;align-items:flex-end;justify-content:space-between;margin-top:9px' },
      el('div', {}, el('div', { style: 'font-weight:800;color:var(--nav);font-size:16px' }, p.nome),
        el('div', { class: 'veic-sub' }, 'Monitoramento 24h · app e painel')),
      el('span', { class: 'badge-ok' }, '● Ativo')),
    el('div', { style: 'margin-top:12px' },
      el('div', { class: 'linha' }, el('span', { class: 'k' }, 'Mensalidade'),
        el('span', { class: 'preco' }, p.mensalidade_centavos ? dinheiro(p.mensalidade_centavos) : 'Incluso', p.mensalidade_centavos ? el('small', {}, '/mês') : null)))));
}

function cardSeguros(seguros) {
  const corpo = seguros.length
    ? seguros.map((s) => {
      const [rot, cls] = STATUS_SEG[s.status] || ['—', 'neutro'];
      return el('div', { class: 'seg' },
        el('div', { class: 'sic' }, ico(IC[s.tipo_icone] || IC.seguro)),
        el('div', {}, el('div', { class: 'nome' }, s.tipo_nome),
          el('div', { class: 'meta' }, s.apolice_numero ? `Apólice ${s.apolice_numero}` : (s.veiculo_placa ? formataPlaca(s.veiculo_placa) : 'Cobertura contratada'))),
        el('div', { class: 'val' }, el('div', { class: 'p' }, s.valor_centavos != null ? dinheiro(s.valor_centavos) : '—'), el('div', { class: `st ${cls}` }, rot)));
    })
    : [el('div', { class: 'vazio' }, ico(IC.seguro), el('div', {}, 'Você ainda não tem seguros contratados.'))];
  return el('div', { class: 'card' }, el('div', { class: 'pad' },
    el('div', { class: 'rot' }, ico(IC.seguro), 'Seguros contratados'),
    el('div', { style: 'margin-top:6px' }, corpo),
    el('button', { class: 'btn claro', onclick: sheetSeguros }, ico(IC.mais), 'Contratar novo seguro')));
}

function cardAtendimento(a) {
  const wa = soDigitos(a.whatsapp);
  const tel = soDigitos(a.telefone);
  const linkWa = wa ? `https://wa.me/${wa.length <= 11 ? '55' + wa : wa}` : null;
  return el('div', { class: 'card' }, el('div', { class: 'pad' },
    el('div', { class: 'rot' }, ico(IC.chat), 'Atendimento'),
    el('div', { class: 'aten' },
      atenLink('wa', IC.whats, true, 'WhatsApp', a.whatsapp || 'Fale conosco', linkWa),
      atenLink('tel', IC.tel, false, 'Telefone', a.telefone || 'Central', tel ? `tel:${tel}` : null),
      atenLink('ch', IC.sino, false, 'Abrir chamado', 'Suporte', linkWa || (tel ? `tel:${tel}` : null)),
      atenLink('doc', IC.doc, false, 'Documentos', 'Apólices', null)),
    a.horario ? el('div', { class: 'horario' }, ico(IC.relogio), a.horario) : el('div', { class: 'horario' }, ico(IC.relogio), 'Emergência 24h · fale com a central')));
}

function atenLink(cls, icone, fill, titulo, sub, href) {
  const conteudo = [el('span', { class: `ai ${cls}` }, ico(icone, fill)), el('div', {}, titulo, el('small', {}, sub))];
  return href
    ? el('a', { href, target: '_blank', rel: 'noopener' }, ...conteudo)
    : el('a', { href: '#', onclick: (e) => { e.preventDefault(); toast('Fale com a central pelo WhatsApp ou telefone.'); } }, ...conteudo);
}

function navInferior() {
  const item = (on, icone, texto, fn) => el('button', { class: on ? 'on' : '', onclick: fn }, ico(icone), texto);
  return el('div', { class: 'nav' },
    item(true, IC.casa, 'Início', () => inicio()),
    item(false, IC.carro, 'Veículo', () => { document.querySelector('.card')?.scrollIntoView({ behavior: 'smooth' }); }),
    item(false, IC.seguro, 'Seguros', sheetSeguros),
    item(false, IC.user, 'Conta', () => { if (confirm('Sair da conta?')) sair(); }));
}

// ---------- Contratar seguro (folha de ações) ----------
async function sheetSeguros() {
  let dados;
  try { dados = await chamar('GET', '/seguros'); } catch (err) { return toast(err.message, true); }
  const fundo = el('div', { class: 'fundo', onclick: (e) => { if (e.target === fundo) fundo.remove(); } });
  const veics = painelDados?.veiculos || [];
  const selV = veics.length
    ? el('label', { class: 'campo-sel' }, el('span', {}, 'Para qual veículo?'),
      el('select', {}, veics.map((v) => el('option', { value: v.id }, formataPlaca(v.placa)))))
    : null;
  const lista = dados.tipos.length
    ? dados.tipos.map((t) => el('button', { class: 'opt', onclick: () => solicitar(t, selV, fundo) },
      el('span', { class: 'sic' }, ico(IC[t.icone] || IC.seguro)),
      el('div', {}, el('div', { class: 'nome' }, t.nome), el('div', { class: 'meta' }, t.descricao || '')),
      el('span', { class: 'p' }, t.preco_venda_centavos != null ? dinheiro(t.preco_venda_centavos) : '')))
    : [el('div', { class: 'vazio' }, 'Nenhum seguro disponível no momento.')];
  fundo.append(el('div', { class: 'sheet' },
    el('button', { class: 'fechar', onclick: () => fundo.remove() }, '×'),
    el('h2', {}, 'Contratar seguro'),
    el('p', { class: 'mudo', style: 'font-size:13px' }, 'Escolha um seguro para solicitar. A empresa confirma e emite a apólice.'),
    selV,
    el('div', {}, lista)));
  document.body.append(fundo);
}

async function solicitar(t, selV, fundo) {
  const veiculoId = selV ? selV.querySelector('select').value : null;
  try {
    await chamar('POST', '/seguros/solicitar', { tipo_id: t.id, veiculo_id: veiculoId });
    fundo.remove();
    toast('Solicitação enviada! A empresa vai confirmar a contratação.');
    inicio();
  } catch (err) { toast(err.message, true); }
}

// placa com hífen (ABC1D23 fica ABC-1D23); se não bater o padrão, mostra como está.
const formataPlaca = (p) => (/^[A-Z]{3}[0-9][0-9A-Z][0-9]{2}$/.test(p ?? '') ? `${p.slice(0, 3)}-${p.slice(3)}` : (p ?? ''));

// ---------- Início ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (sessao?.token) inicio(); else entrar();
