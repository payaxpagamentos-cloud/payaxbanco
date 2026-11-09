/**
 * App do motorista: entra com CPF e senha numérica e, no celular:
 * - assume o veículo pelo QR code (a câmera do celular abre o link do QR);
 * - SOS (segurar 2 s), com a localização do celular;
 * - pede a liberação do bloqueio programado (código para o gestor);
 * - checklist de saída, abastecimento e avaria, com fotos;
 * - a própria nota, com as dicas;
 * - avisos no celular.
 */
import { BASE } from '../js/api.js';
import { el, limpar, icone, placa } from '../js/ui.js';

const raiz = document.getElementById('app');
const CHAVE = 'rastreador.motorista';
const CHAVE_CODIGO = 'rastreador.motorista.codigo';
const CHAVE_QR = 'rastreador.motorista.qr';
// Tudo dentro do try: em navegador com armazenamento bloqueado, até ler `localStorage` lança erro.
const area = (onde) => (onde === 'sessao' ? sessionStorage : localStorage);
const ler = (k, onde) => { try { return JSON.parse(area(onde).getItem(k)); } catch { return null; } };
const gravar = (k, v, onde) => { try { if (v === null) area(onde).removeItem(k); else area(onde).setItem(k, JSON.stringify(v)); } catch { /* sem armazenamento */ } };
let sessao = ler(CHAVE);
let dados = null;
let timer = null;
let relogio = null;

// QR code do veículo: a câmera abre ".../motorista/#veiculo=CODIGO". Guarda o código até entrar.
const qrDoLink = /^#veiculo=([\w-]{8,20})$/.exec(location.hash);
if (qrDoLink) { gravar(CHAVE_QR, qrDoLink[1], 'sessao'); history.replaceState(null, '', location.pathname); }

async function chamar(metodo, caminho, corpo) {
  let resp;
  try {
    resp = await fetch(`${BASE}/api/motorista${caminho}`, {
      method: metodo,
      headers: { ...(corpo ? { 'Content-Type': 'application/json' } : {}), ...(sessao?.token ? { Authorization: `Bearer ${sessao.token}` } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
  } catch {
    throw new Error('Sem internet agora. Tente de novo.');
  }
  if (resp.status === 401 && caminho !== '/login') { sair(); throw new Error('Sua sessão terminou. Entre de novo.'); }
  const r = resp.status === 204 ? null : await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(r?.erro || (resp.status === 413 ? 'Fotos grandes demais. Envie menos fotos.' : `Erro ${resp.status}`));
  return r;
}

const horaDe = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dataHora = (iso) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const reais = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const diasTexto = (d) => (d === '12345' ? 'segunda a sexta' : d === '0123456' ? 'todos os dias' : [...String(d)].map((x) => DIAS[Number(x)]).join(', '));
const aviso = (alvo, msg, tipo = 'erro') => limpar(alvo, msg ? el('p', { class: `aviso ${tipo}` }, msg) : null);

function sair() {
  sessao = null;
  gravar(CHAVE, null);
  gravar(CHAVE_CODIGO, null);
  clearInterval(timer);
  clearInterval(relogio);
  entrar();
}

const marcaApp = () => el('div', { class: 'motorista-marca' }, el('span', { class: 'marca-icone' }, icone('radar')), el('span', {}, 'App do motorista'));

/** Tela com o botão Voltar no topo. */
function tela(titulo, ...conteudo) {
  clearInterval(timer);
  clearInterval(relogio);
  limpar(raiz, el('header', { class: 'motorista-topo' }, el('button', { class: 'btn pequeno voltar-app', type: 'button', onclick: () => inicio() }, icone('seta'), 'Voltar'),
    el('strong', {}, titulo), el('span')), el('div', { class: 'coluna', style: 'gap:14px' }, conteudo));
  scrollTo(0, 0);
}

// ---------- Entrar ----------
function entrar() {
  const cpf = el('input', { name: 'cpf', inputmode: 'numeric', autocomplete: 'username', required: true, placeholder: '000.000.000-00', maxlength: 14 });
  cpf.addEventListener('input', () => {
    const d = cpf.value.replace(/\D/g, '').slice(0, 11);
    cpf.value = d.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/(\d{3})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3-$4');
  });
  const senha = el('input', { name: 'senha', type: 'password', inputmode: 'numeric', autocomplete: 'current-password', required: true, maxlength: 6, placeholder: '••••' });
  const erro = el('div');
  const botao = el('button', { class: 'btn primario largo' }, 'Entrar');
  const f = el('form', { class: 'form' }, el('label', { class: 'campo' }, 'CPF', cpf), el('label', { class: 'campo' }, 'Senha (só números)', senha), erro, botao);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    botao.disabled = true;
    aviso(erro);
    try {
      sessao = await chamar('POST', '/login', { cpf: cpf.value, senha: senha.value });
      gravar(CHAVE, sessao);
      inicio();
    } catch (err) {
      aviso(erro, err.message);
    } finally {
      botao.disabled = false;
    }
  });
  limpar(raiz, el('section', { class: 'motorista-entrada' }, marcaApp(),
    el('h1', {}, 'Olá, motorista.'),
    el('p', { class: 'mudo' }, ler(CHAVE_QR, 'sessao') ? 'Entre para assumir o veículo do QR code.' : 'Entre com o seu CPF e a senha que o gestor cadastrou para você.'), f,
    el('p', { class: 'pequeno fraco' }, 'Esqueceu a senha? Peça ao gestor da frota para cadastrar uma nova.')));
  cpf.focus();
}

// ---------- Fotos (reduzidas no celular antes de enviar) ----------
async function reduzir(arquivo, lado = 1280, qualidade = 0.72) {
  const img = await new Promise((ok, falha) => {
    const i = new Image();
    i.onload = () => ok(i);
    i.onerror = () => falha(new Error('Não foi possível abrir a foto.'));
    i.src = URL.createObjectURL(arquivo);
  });
  const escala = Math.min(1, lado / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * escala);
  c.height = Math.round(img.naturalHeight * escala);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(img.src);
  return c.toDataURL('image/jpeg', qualidade);
}
/** Seletor de fotos (câmera ou galeria), com as miniaturas. `lista` recebe os dataURLs. */
function seletorFotos(lista, max = 4, rotulo = 'Adicionar foto') {
  const miniaturas = el('div', { class: 'miniaturas' });
  const entrada = el('input', { type: 'file', accept: 'image/*', multiple: true, class: 'oculto' });
  const botao = el('button', { type: 'button', class: 'btn largo foto-btn', onclick: () => entrada.click() }, icone('camera'), rotulo);
  const desenhar = () => {
    limpar(miniaturas, lista.map((src, i) => el('div', { class: 'miniatura' }, el('img', { src, alt: `Foto ${i + 1}` }),
      el('button', { type: 'button', 'aria-label': 'Tirar a foto', onclick: () => { lista.splice(i, 1); desenhar(); } }, icone('fechar')))));
    botao.disabled = lista.length >= max;
  };
  entrada.addEventListener('change', async () => {
    for (const f of [...entrada.files].slice(0, max - lista.length)) {
      try { lista.push(await reduzir(f)); } catch { /* foto ilegível: ignora */ }
    }
    entrada.value = '';
    desenhar();
  });
  return el('div', { class: 'seletor-fotos' }, miniaturas, botao, entrada);
}

/** Escolha do veículo quando o motorista tem mais de um. */
function escolhaVeiculo() {
  const vs = dados?.veiculos ?? [];
  if (vs.length <= 1) return { valor: () => vs[0]?.id, campo: vs[0] ? el('div', { class: 'veiculo-escolhido' }, icone('veiculos'), el('strong', {}, placa(vs[0].placa)), vs[0].descricao ? el('span', { class: 'mudo' }, vs[0].descricao) : null) : null };
  const s = el('select', {}, vs.map((v) => el('option', { value: v.id }, `${placa(v.placa)}${v.descricao ? ` · ${v.descricao}` : ''}`)));
  return { valor: () => Number(s.value), campo: el('label', { class: 'campo' }, 'Veículo', s) };
}

function semVeiculo() {
  return el('div', { class: 'cartao vazio-app' }, icone('qr'), el('strong', {}, 'Nenhum veículo com você'),
    el('p', { class: 'mudo' }, 'Aponte a câmera do celular para o QR code colado no veículo e toque no link que aparecer.'));
}

async function enviarForm(botao, erro, fn) {
  botao.disabled = true;
  aviso(erro);
  try { await fn(); } catch (err) { aviso(erro, err.message); } finally { botao.disabled = false; }
}

function feito(titulo, texto) {
  tela(titulo, el('div', { class: 'cartao feito' }, el('span', { class: 'feito-icone' }, icone('check')), el('h2', {}, titulo), el('p', { class: 'mudo' }, texto),
    el('button', { class: 'btn primario largo', onclick: () => inicio() }, 'Voltar ao início')));
}

// ---------- Checklist de saída ----------
function telaChecklist() {
  if (!dados.veiculos.length) return tela('Checklist de saída', semVeiculo());
  const ve = escolhaVeiculo();
  const respostas = new Map();
  const fotos = [];
  const lista = el('div', { class: 'checklist' }, dados.checklist_itens.map((item) => {
    const obs = el('input', { class: 'obs oculto', maxlength: 200, placeholder: 'O que está errado?' });
    const linha = el('div', { class: 'item-check' });
    const marcar = (ok) => {
      respostas.set(item.id, { id: item.id, ok, obs });
      linha.classList.toggle('ok', ok);
      linha.classList.toggle('problema', !ok);
      obs.classList.toggle('oculto', ok);
      if (!ok) obs.focus();
    };
    linha.append(el('span', {}, item.texto), el('div', { class: 'opcoes' },
      el('button', { type: 'button', class: 'opcao-ok', onclick: () => marcar(true) }, icone('check'), 'OK'),
      el('button', { type: 'button', class: 'opcao-problema', onclick: () => marcar(false) }, icone('fechar'), 'Problema')), obs);
    return linha;
  }));
  const km = el('input', { inputmode: 'numeric', maxlength: 8, placeholder: 'Opcional' });
  const tudoOk = el('button', { type: 'button', class: 'btn pequeno', onclick: () => lista.querySelectorAll('.opcao-ok').forEach((b) => b.click()) }, 'Marcar tudo OK');
  const erro = el('div');
  const enviar = el('button', { class: 'btn primario largo', type: 'button' }, 'Enviar checklist');
  enviar.addEventListener('click', () => enviarForm(enviar, erro, async () => {
    const itens = dados.checklist_itens.map((i) => respostas.get(i.id)).filter(Boolean);
    if (itens.length < dados.checklist_itens.length) throw new Error('Responda todos os itens (OK ou Problema).');
    const r = await chamar('POST', '/checklists', { veiculo_id: ve.valor(), km: km.value.replace(/\D/g, '') || null, fotos,
      itens: itens.map((i) => ({ id: i.id, ok: i.ok, obs: i.ok ? undefined : i.obs.value })) });
    feito(r.aprovado ? 'Checklist enviado' : 'Checklist enviado com problema', r.aprovado ? 'Tudo certo. Boa viagem!' : 'O gestor foi avisado dos itens com problema.');
  }));
  tela('Checklist de saída', ve.campo, el('div', { class: 'linha entre' }, el('span', { class: 'mudo pequeno' }, 'Confira antes de sair.'), tudoOk), lista,
    el('label', { class: 'campo' }, 'Km do painel', km), el('div', {}, el('strong', { class: 'pequeno' }, 'Fotos (opcional)'), seletorFotos(fotos)), erro, enviar);
}

// ---------- Abastecimento ----------
function telaAbastecimento() {
  if (!dados.veiculos.length) return tela('Abastecimento', semVeiculo());
  const ve = escolhaVeiculo();
  const fotos = [];
  const litros = el('input', { inputmode: 'decimal', maxlength: 7, placeholder: '0,0', required: true });
  const valor = el('input', { inputmode: 'decimal', maxlength: 10, placeholder: '0,00', required: true });
  const preco = el('p', { class: 'pequeno mudo', style: 'margin:0' });
  const calc = () => {
    const l = Number(litros.value.replace(',', '.'));
    const vv = Number(valor.value.replace(/\./g, '').replace(',', '.'));
    preco.textContent = l > 0 && vv > 0 ? `Preço por litro: ${reais(Math.round((vv / l) * 100))}` : '';
  };
  litros.addEventListener('input', calc);
  valor.addEventListener('input', calc);
  const km = el('input', { inputmode: 'numeric', maxlength: 8, placeholder: 'Opcional' });
  const posto = el('input', { maxlength: 80, placeholder: 'Opcional' });
  const completo = el('input', { type: 'checkbox', checked: true });
  const erro = el('div');
  const enviar = el('button', { class: 'btn primario largo', type: 'button' }, 'Registrar abastecimento');
  enviar.addEventListener('click', () => enviarForm(enviar, erro, async () => {
    const vv = Number(valor.value.replace(/\./g, '').replace(',', '.'));
    if (!(vv > 0)) throw new Error('Informe o valor pago.');
    await chamar('POST', '/abastecimentos', { veiculo_id: ve.valor(), litros: litros.value, valor_centavos: Math.round(vv * 100), km: km.value.replace(/\D/g, '') || null,
      posto: posto.value, completo: completo.checked, fotos });
    feito('Abastecimento registrado', 'O consumo real do veículo foi atualizado.');
  }));
  tela('Abastecimento', ve.campo,
    el('div', { class: 'duas' }, el('label', { class: 'campo' }, 'Litros', litros), el('label', { class: 'campo' }, 'Valor pago (R$)', valor)), preco,
    el('div', { class: 'duas' }, el('label', { class: 'campo' }, 'Km do painel', km), el('label', { class: 'campo' }, 'Posto', posto)),
    el('label', { class: 'marcar' }, completo, 'Tanque cheio'),
    el('div', {}, el('strong', { class: 'pequeno' }, 'Foto do cupom'), seletorFotos(fotos, 2, 'Fotografar o cupom')), erro, enviar);
}

// ---------- Avaria ----------
function telaAvaria() {
  if (!dados.veiculos.length) return tela('Reportar avaria', semVeiculo());
  const ve = escolhaVeiculo();
  const fotos = [];
  let gravidade = 'media';
  const descricao = el('textarea', { rows: 4, maxlength: 500, placeholder: 'Ex.: barulho no freio dianteiro, retrovisor quebrado…' });
  const chips = el('div', { class: 'chips' });
  const OPCOES = { baixa: 'Baixa', media: 'Média', alta: 'Não dá para rodar' };
  const desenhar = () => limpar(chips, Object.entries(OPCOES).map(([k, t]) => el('button', { type: 'button', class: `chip${k === gravidade ? ' on' : ''}${k === 'alta' ? ' grave' : ''}`,
    onclick: () => { gravidade = k; desenhar(); } }, t)));
  desenhar();
  const erro = el('div');
  const enviar = el('button', { class: 'btn primario largo', type: 'button' }, 'Enviar ao gestor');
  enviar.addEventListener('click', () => enviarForm(enviar, erro, async () => {
    await chamar('POST', '/avarias', { veiculo_id: ve.valor(), descricao: descricao.value, gravidade, fotos });
    feito('Avaria enviada', 'O gestor recebeu e vai abrir o chamado de manutenção.');
  }));
  tela('Reportar avaria', ve.campo, el('label', { class: 'campo' }, 'O que aconteceu?', descricao), el('div', {}, el('strong', { class: 'pequeno' }, 'Gravidade'), chips),
    el('div', {}, el('strong', { class: 'pequeno' }, 'Fotos'), seletorFotos(fotos)), erro, enviar);
}

// ---------- Minha nota ----------
async function telaNota(periodo = 'semana') {
  const corpo = el('div', { class: 'coluna', style: 'gap:14px' }, el('p', { class: 'mudo' }, 'Calculando…'));
  const chips = el('div', { class: 'chips centro' }, [['semana', 'Esta semana'], ['mes', 'Este mês']].map(([k, t]) =>
    el('button', { type: 'button', class: `chip${k === periodo ? ' on' : ''}`, onclick: () => telaNota(k) }, t)));
  tela('Minha nota', chips, corpo);
  let n;
  try { n = await chamar('GET', `/nota?periodo=${periodo}`); } catch (err) { return aviso(corpo, err.message); }
  const tom = n.nota === null ? '' : n.nota >= 85 ? 'ok' : n.nota >= 70 ? 'aviso' : 'erro';
  limpar(corpo,
    el('div', { class: `cartao nota-app tom-${tom}` },
      el('div', { class: 'anel', style: `--p:${n.nota ?? 0}` }, el('strong', {}, n.nota ?? '—'), el('span', {}, 'de 100')),
      el('div', {}, el('strong', {}, n.nota === null ? 'Sem viagens no período' : n.nota >= 85 ? 'Excelente!' : n.nota >= 70 ? 'Bom, dá para melhorar' : 'Atenção'),
        el('p', { class: 'mudo pequeno' }, `${String(n.km).replace('.', ',')} km rodados`),
        n.posicao ? el('p', { class: 'posicao-app' }, icone('estrela'), `${n.posicao.lugar}º de ${n.posicao.de} motoristas`) : null)),
    el('section', { class: 'cartao' }, el('h2', {}, 'Dicas'), el('ul', { class: 'dicas' }, n.dicas.map((d) => el('li', {},
      d.pontos ? el('span', { class: 'menos' }, `−${String(d.pontos).replace('.', ',')}`) : el('span', { class: 'mais' }, icone('check')), el('span', {}, d.texto))))),
    n.ocorrencias.length ? el('section', { class: 'cartao' }, el('h2', {}, 'Onde perdeu pontos'), el('ul', { class: 'pedidos' }, n.ocorrencias.map((o) => el('li', {},
      el('div', {}, el('strong', {}, o.tipo === 'velocidade' ? 'Excesso de velocidade' : 'Fora do horário'), el('div', { class: 'pequeno mudo' }, o.mensagem)),
      el('div', { class: 'dir pequeno mudo' }, dataHora(o.em)))))) : null);
}

// ---------- SOS ----------
function botaoSos(veiculos) {
  const anel = el('span', { class: 'sos-progresso' });
  const texto = el('span', { class: 'sos-texto' }, el('strong', {}, 'SOS'), el('small', {}, 'segure 2 segundos'));
  const b = el('button', { type: 'button', class: 'sos', 'aria-label': 'SOS: segure por 2 segundos para pedir ajuda' }, anel, icone('sos'), texto);
  let t = null;
  const cancelar = () => { clearTimeout(t); t = null; b.classList.remove('segurando'); };
  const disparar = async () => {
    b.classList.remove('segurando');
    b.classList.add('enviando');
    texto.replaceChildren(el('strong', {}, 'Enviando…'));
    navigator.vibrate?.(200);
    const local = await new Promise((ok) => {
      if (!navigator.geolocation) return ok(null);
      navigator.geolocation.getCurrentPosition((p) => ok({ lat: p.coords.latitude, lng: p.coords.longitude }), () => ok(null), { enableHighAccuracy: true, timeout: 7000, maximumAge: 30_000 });
    });
    try {
      await chamar('POST', '/sos', { veiculo_id: veiculos[0]?.id, ...(local ?? {}) });
      tela('SOS enviado', el('div', { class: 'cartao feito sos-feito' }, el('span', { class: 'feito-icone' }, icone('sos')),
        el('h2', {}, 'Ajuda pedida'), el('p', { class: 'mudo' }, `A central e o gestor foram avisados${local ? ' com a sua localização' : ''}. Se puder, saia de perto do perigo.`),
        el('a', { class: 'btn perigo largo', href: 'tel:190' }, 'Ligar para a polícia (190)'),
        el('button', { class: 'btn largo', onclick: () => inicio() }, 'Voltar ao início')));
    } catch (err) {
      b.classList.remove('enviando');
      texto.replaceChildren(el('strong', {}, 'SOS'), el('small', {}, err.message));
    }
  };
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); b.classList.add('segurando'); t = setTimeout(disparar, 2000); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => { if (t) cancelar(); });
  b.addEventListener('contextmenu', (e) => e.preventDefault());
  return b;
}

// ---------- Avisos no celular ----------
const chaveBytes = (b64) => {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};
function cartaoAvisos() {
  const suporte = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const iphone = /iPhone|iPad/.test(navigator.userAgent);
  const estado = el('span', { class: 'pequeno mudo' });
  const botao = el('button', { type: 'button', class: 'btn pequeno' });
  const desenhar = () => {
    const ligado = dados.avisos.inscrito && Notification.permission === 'granted';
    estado.textContent = ligado ? 'Ligados neste celular' : Notification.permission === 'denied' ? 'Bloqueados nas configurações do navegador' : 'Desligados';
    botao.textContent = ligado ? 'Desligar' : 'Ligar avisos';
    botao.disabled = Notification.permission === 'denied';
  };
  if (!suporte) {
    return el('div', { class: 'cartao avisos-app' }, icone('alertas'), el('div', {}, el('strong', {}, 'Avisos no celular'),
      el('p', { class: 'pequeno mudo', style: 'margin:0' }, iphone ? 'No iPhone: toque em Compartilhar › Adicionar à Tela de Início e abra o app por lá para receber avisos.'
        : 'Este navegador não recebe avisos. Use o Chrome.')));
  }
  botao.addEventListener('click', async () => {
    botao.disabled = true;
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      const atual = await reg.pushManager.getSubscription();
      if (dados.avisos.inscrito && atual && Notification.permission === 'granted') {
        await chamar('DELETE', '/avisos', { endpoint: atual.endpoint });
        await atual.unsubscribe();
        dados.avisos.inscrito = false;
      } else {
        if (await Notification.requestPermission() !== 'granted') throw new Error('Permita os avisos para o app.');
        const s = atual ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: chaveBytes(dados.avisos.chave) });
        await chamar('POST', '/avisos', s.toJSON());
        dados.avisos.inscrito = true;
      }
    } catch (err) {
      estado.textContent = err.message;
    } finally {
      botao.disabled = false;
      desenhar();
    }
  });
  desenhar();
  return el('div', { class: 'cartao avisos-app' }, icone('alertas'), el('div', {}, el('strong', {}, 'Avisos no celular'),
    el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'Liberação, início do bloqueio e fim da liberação.'), estado), botao);
}

// ---------- Início ----------
function situacaoVeiculo(v) {
  if (v.liberado_ate) return ['ok', 'Liberado', `até ${horaDe(v.liberado_ate)}`];
  if (v.agenda?.em_horario) return v.bloqueado ? ['erro', 'Bloqueado', `até ${v.agenda.fim}`] : ['aviso', 'No horário do bloqueio', `bloqueia assim que parar · até ${v.agenda.fim}`];
  if (v.agenda) return ['ok', 'Liberado', `bloqueia às ${v.agenda.inicio}`];
  if (v.bloqueado) return ['erro', 'Bloqueado', 'fale com o gestor'];
  return ['ok', 'Liberado', 'sem bloqueio programado'];
}

function cartaoCodigo(v, c, aoTrocar) {
  const resta = el('span', {});
  const atualizar = () => {
    const s = Math.max(0, Math.round((Date.parse(c.expira_em) - Date.now()) / 1000));
    resta.textContent = s ? `Expira em ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : 'Código expirado';
    if (!s) { clearInterval(relogio); gravar(CHAVE_CODIGO, null); aoTrocar(); }
  };
  clearInterval(relogio);
  relogio = setInterval(atualizar, 1000);
  atualizar();
  return el('div', { class: 'codigo-motorista' },
    el('p', {}, 'Passe este código para o seu gestor. Ele confere e libera o veículo.'),
    el('div', { class: 'numero', 'aria-label': `Código ${c.codigo.split('').join(' ')}` }, `${c.codigo.slice(0, 3)} ${c.codigo.slice(3)}`),
    el('div', { class: 'pequeno' }, resta, ` · pedido de ${c.horas} h`),
    el('div', { class: 'linha', style: 'justify-content:center;margin-top:10px' },
      navigator.share ? el('button', { class: 'btn', type: 'button', onclick: () => navigator.share({ text: `Código de liberação do ${placa(v.placa)}: ${c.codigo}` }).catch(() => {}) }, 'Enviar ao gestor') : null,
      el('button', { class: 'btn', type: 'button', onclick: () => { gravar(CHAVE_CODIGO, null); aoTrocar(); } }, 'Gerar outro código')));
}

function pedir(v, alvo, aoTerminar) {
  let horas = 2;
  const chips = el('div', { class: 'chips' });
  const erro = el('div');
  const botao = el('button', { class: 'btn primario largo', type: 'button' });
  const desenhar = () => {
    botao.textContent = `Gerar código para ${horas} h`;
    limpar(chips, [1, 2, 4, 8].map((h) => el('button', { type: 'button', class: `chip${h === horas ? ' on' : ''}`, onclick: () => { horas = h; desenhar(); } }, `${h} h`)));
  };
  desenhar();
  botao.addEventListener('click', () => enviarForm(botao, erro, async () => {
    const r = await chamar('POST', '/liberacoes', { veiculo_id: v.id, horas });
    gravar(CHAVE_CODIGO, { veiculo_id: v.id, ...r });
    aoTerminar();
  }));
  limpar(alvo, el('div', { class: 'pedir' }, el('strong', {}, 'Por quanto tempo você precisa do veículo?'), chips, erro, botao));
}

async function assumirPeloQr(codigo) {
  gravar(CHAVE_QR, null, 'sessao');
  let q;
  try {
    q = await chamar('GET', `/qr/${encodeURIComponent(codigo)}`);
  } catch (err) {
    // O código fica na tela para tentar de novo (ex.: sem internet na garagem), sem precisar escanear outra vez.
    return tela('QR code', el('p', { class: 'aviso erro' }, err.message),
      el('button', { class: 'btn primario largo', type: 'button', onclick: () => assumirPeloQr(codigo) }, 'Tentar de novo'));
  }
  if (q.com_voce) return inicio();
  const erro = el('div');
  const botao = el('button', { class: 'btn primario largo', type: 'button' }, icone('veiculos'), `Assumir o ${placa(q.placa)}`);
  botao.addEventListener('click', () => enviarForm(botao, erro, async () => { await chamar('POST', '/assumir', { codigo }); inicio(); }));
  tela('Assumir o veículo', el('div', { class: 'cartao feito' }, el('span', { class: 'feito-icone' }, icone('qr')), el('h2', {}, placa(q.placa)), q.descricao ? el('p', { class: 'mudo' }, q.descricao) : null,
    el('p', { class: 'pequeno mudo' }, q.com ? `Hoje o veículo está com ${q.com}. Ao assumir, ele passa para você.` : 'A partir de agora, a nota e o custo do veículo contam para você.'),
    erro, botao));
}

async function inicio() {
  clearInterval(timer);
  const codigoQr = ler(CHAVE_QR, 'sessao');
  if (codigoQr) return assumirPeloQr(codigoQr);
  const corpo = el('div', { class: 'coluna', style: 'gap:14px' });
  limpar(raiz, el('header', { class: 'motorista-topo' }, marcaApp(), el('button', { class: 'btn pequeno', onclick: sair }, 'Sair')), corpo);
  async function carregar() {
    try { dados = await chamar('GET', '/eu'); } catch (err) { if (sessao) aviso(corpo, err.message); return; }
    const codigo = ler(CHAVE_CODIGO);
    const valido = codigo && Date.parse(codigo.expira_em) > Date.now() ? codigo : null;
    if (!valido && codigo) gravar(CHAVE_CODIGO, null);
    const atalho = (ic, titulo, sub, fn) => el('button', { type: 'button', class: 'atalho-app', onclick: fn }, el('span', { class: 'atalho-icone' }, icone(ic)),
      el('strong', {}, titulo), el('small', {}, sub));
    limpar(corpo,
      el('div', {}, el('h1', {}, `Olá, ${String(dados.motorista.nome).split(' ')[0]}.`), el('p', { class: 'mudo', style: 'margin:0' }, dados.motorista.empresa ?? '')),
      dados.veiculos.length ? dados.veiculos.map((v) => {
        const [tom, rotulo, nota] = situacaoVeiculo(v);
        const area = el('div');
        const meu = valido && valido.veiculo_id === v.id;
        if (meu && !v.liberado_ate) area.append(cartaoCodigo(v, valido, carregar));
        else if (meu && v.liberado_ate) gravar(CHAVE_CODIGO, null);
        else if (v.agenda && !v.liberado_ate) {
          area.append(el('button', { class: 'btn primario largo', type: 'button', onclick: () => pedir(v, area, carregar) }, icone('aberto'), 'Pedir liberação'));
        }
        return el('article', { class: `veiculo-motorista tom-${tom}` },
          el('div', { class: 'linha entre' }, el('div', {}, el('h2', {}, placa(v.placa)), el('div', { class: 'pequeno mudo' }, v.descricao ?? '')),
            el('div', { class: 'estado' }, el('strong', {}, rotulo), el('span', {}, nota))),
          v.assumido_em ? el('div', { class: 'linha entre assumido' }, el('span', { class: 'pequeno mudo' }, `Com você desde ${dataHora(v.assumido_em)} (QR code)`),
            el('button', { type: 'button', class: 'btn pequeno', onclick: async (e) => { e.currentTarget.disabled = true; await chamar('POST', '/devolver', {}).catch(() => {}); carregar(); } }, 'Devolver')) : null,
          v.agenda ? el('p', { class: 'pequeno mudo', style: 'margin:0' }, `Bloqueio programado: ${diasTexto(v.agenda.dias)}, das ${v.agenda.inicio} às ${v.agenda.fim}.`) : null,
          v.pedido_aberto && !meu ? el('p', { class: 'aviso pequeno', style: 'margin:0' }, `Há um código aguardando o gestor (vale até ${horaDe(v.pedido_aberto.expira_em)}).`) : null,
          area);
      }) : semVeiculo(),
      botaoSos(dados.veiculos),
      el('div', { class: 'atalhos-app' },
        atalho('check', 'Checklist', 'antes de sair', telaChecklist),
        atalho('combustivel', 'Abastecer', 'litros e cupom', telaAbastecimento),
        atalho('manutencao', 'Avaria', 'avisar o gestor', telaAvaria),
        atalho('estrela', 'Minha nota', 'e as dicas', () => telaNota())),
      cartaoAvisos(),
      dados.pedidos.length ? el('section', { class: 'cartao' }, el('h2', {}, 'Meus pedidos de liberação'), el('ul', { class: 'pedidos' }, dados.pedidos.slice(0, 6).map((p) => el('li', {},
        el('div', {}, el('strong', {}, placa(p.placa)), el('div', { class: 'pequeno mudo' }, dataHora(p.criado_em))),
        el('div', { class: 'dir' }, el('span', { class: `etiqueta ${p.status === 'ativa' ? 'ok' : p.status === 'aguardando' ? 'aviso' : ''}` },
          { ativa: 'liberado', aguardando: 'aguardando', expirada: 'expirou', encerrada: 'encerrado', cancelada: 'cancelado' }[p.status] ?? p.status),
        el('div', { class: 'pequeno mudo' }, p.libera_ate ? `${p.horas} h · até ${horaDe(p.libera_ate)}${p.aplicada_por ? ` · ${p.aplicada_por}` : ''}` : `pedido de ${p.horas_pedidas} h`)))))) : null);
  }
  await carregar();
  if (!sessao) return; // a sessão venceu durante a carga: a tela de entrada já está na página
  timer = setInterval(() => { if (document.visibilityState === 'visible' && !document.querySelector('.pedir')) carregar(); }, 20_000);
}

if (sessao?.token) inicio(); else entrar();
