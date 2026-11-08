/** App do motorista: entra com CPF e senha numérica, vê se o veículo está liberado e gera o código de liberação para o gestor. */
import { BASE } from '../js/api.js';
import { el, limpar, icone, placa } from '../js/ui.js';

const raiz = document.getElementById('app');
const CHAVE = 'rastreador.motorista';
const CHAVE_CODIGO = 'rastreador.motorista.codigo';
const ler = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const gravar = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem armazenamento */ } };
let sessao = ler(CHAVE);
let timer = null;
let relogio = null;

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
  const dados = resp.status === 204 ? null : await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(dados?.erro || `Erro ${resp.status}`);
  return dados;
}

const horaDe = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dataHora = (iso) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const diasTexto = (d) => (d === '12345' ? 'segunda a sexta' : d === '0123456' ? 'todos os dias' : [...String(d)].map((x) => DIAS[Number(x)]).join(', '));
const erroEm = (alvo, msg) => limpar(alvo, msg ? el('p', { class: 'aviso erro' }, msg) : null);

function sair() {
  sessao = null;
  gravar(CHAVE, null);
  gravar(CHAVE_CODIGO, null);
  clearInterval(timer);
  clearInterval(relogio);
  entrar();
}

function marcaApp() {
  return el('div', { class: 'motorista-marca' }, el('span', { class: 'marca-icone' }, icone('radar')), el('span', {}, 'App do motorista'));
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
    erroEm(erro);
    try {
      sessao = await chamar('POST', '/login', { cpf: cpf.value, senha: senha.value });
      gravar(CHAVE, sessao);
      inicio();
    } catch (err) {
      erroEm(erro, err.message);
    } finally {
      botao.disabled = false;
    }
  });
  limpar(raiz, el('section', { class: 'motorista-entrada' }, marcaApp(),
    el('h1', {}, 'Olá, motorista.'),
    el('p', { class: 'mudo' }, 'Entre com o seu CPF e a senha que o gestor cadastrou para você.'), f,
    el('p', { class: 'pequeno fraco' }, 'Esqueceu a senha? Peça ao gestor da frota para cadastrar uma nova.')));
  cpf.focus();
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
    if (!s) { gravar(CHAVE_CODIGO, null); aoTrocar(); }
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
  botao.addEventListener('click', async () => {
    botao.disabled = true;
    erroEm(erro);
    try {
      const r = await chamar('POST', '/liberacoes', { veiculo_id: v.id, horas });
      gravar(CHAVE_CODIGO, { veiculo_id: v.id, ...r });
      aoTerminar();
    } catch (err) {
      erroEm(erro, err.message);
    } finally {
      botao.disabled = false;
    }
  });
  limpar(alvo, el('div', { class: 'pedir' }, el('strong', {}, 'Por quanto tempo você precisa do veículo?'), chips, erro, botao));
}

async function inicio() {
  clearInterval(timer);
  const corpo = el('div', { class: 'coluna', style: 'gap:14px' });
  limpar(raiz, el('header', { class: 'motorista-topo' }, marcaApp(), el('button', { class: 'btn pequeno', onclick: sair }, 'Sair')), corpo);
  async function carregar() {
    let d;
    try { d = await chamar('GET', '/eu'); } catch (err) { if (sessao) erroEm(corpo, err.message); return; }
    const codigo = ler(CHAVE_CODIGO);
    const valido = codigo && Date.parse(codigo.expira_em) > Date.now() ? codigo : null;
    if (!valido && codigo) gravar(CHAVE_CODIGO, null);
    limpar(corpo,
      el('div', {}, el('h1', {}, `Olá, ${String(d.motorista.nome).split(' ')[0]}.`), el('p', { class: 'mudo', style: 'margin:0' }, d.motorista.empresa ?? '')),
      d.veiculos.length ? d.veiculos.map((v) => {
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
          v.agenda ? el('p', { class: 'pequeno mudo', style: 'margin:0' }, `Bloqueio programado: ${diasTexto(v.agenda.dias)}, das ${v.agenda.inicio} às ${v.agenda.fim}.`) : null,
          v.pedido_aberto && !meu ? el('p', { class: 'aviso pequeno', style: 'margin:0' }, `Há um código aguardando o gestor (vale até ${horaDe(v.pedido_aberto.expira_em)}).`) : null,
          area);
      }) : el('p', { class: 'aviso' }, 'Nenhum veículo está no seu nome. Peça ao gestor para definir você como motorista do veículo.'),
      d.pedidos.length ? el('section', { class: 'cartao' }, el('h2', {}, 'Meus pedidos'), el('ul', { class: 'pedidos' }, d.pedidos.map((p) => el('li', {},
        el('div', {}, el('strong', {}, placa(p.placa)), el('div', { class: 'pequeno mudo' }, dataHora(p.criado_em))),
        el('div', { class: 'dir' }, el('span', { class: `etiqueta ${p.status === 'ativa' ? 'ok' : p.status === 'aguardando' ? 'aviso' : ''}` },
          { ativa: 'liberado', aguardando: 'aguardando', expirada: 'expirou', encerrada: 'encerrado', cancelada: 'cancelado' }[p.status] ?? p.status),
        el('div', { class: 'pequeno mudo' }, p.libera_ate ? `${p.horas} h · até ${horaDe(p.libera_ate)}${p.aplicada_por ? ` · ${p.aplicada_por}` : ''}` : `pedido de ${p.horas_pedidas} h`)))))) : null);
  }
  await carregar();
  timer = setInterval(() => { if (document.visibilityState === 'visible') carregar(); }, 20_000);
}

if (sessao?.token) inicio(); else entrar();
