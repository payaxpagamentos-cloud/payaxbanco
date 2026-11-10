/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

/** Gestão do app do cliente: usuários finais (acesso + veículos vinculados) e as informações de atendimento/plano. */
import { api, BASE } from './api.js';
import { el, limpar, toast, formModal, confirmar, perguntar, campo, marcar, etiqueta, placa, dataHora } from './ui.js';
import { cartao, tabela, td, botaoIcone } from './comum.js';

const base = (ctx) => `/empresas/${ctx.empresaId}`;
const lerMarcados = (checks) => checks.filter((c) => c.querySelector('input').checked).map((c) => Number(c.querySelector('input').value));

async function telaUsuariosApp(ctx) {
  const lista = el('div');
  let veiculos = [];
  async function carregar() {
    const dados = await api.get(`${base(ctx)}/usuarios-app`);
    veiculos = dados.veiculos;
    limpar(lista, tabela(['Nome', 'Acesso', '^Veículos', '^Situação', '^Ações'], dados.usuarios.map((u) => el('tr', {},
      td(el('strong', {}, u.nome)),
      td(el('span', { class: 'mudo' }, u.email || u.cpf || '—')),
      td(String(u.veiculos.length), 'centro'),
      td(u.tem_senha ? (u.ativo ? etiqueta('ativo', 'ok') : etiqueta('inativo', '')) : etiqueta('sem senha', 'aviso'), 'centro'),
      el('td', { class: 'acoes' },
        botaoIcone('editar', 'Editar', async () => { if (await formUsuario(ctx, veiculos, u)) carregar(); }),
        botaoIcone('cadeado', 'Definir senha', async () => {
          const senha = await perguntar(`Senha de ${u.nome}`, 'Nova senha (mínimo 6 caracteres) para o app do cliente');
          if (!senha) return;
          await api.post(`${base(ctx)}/usuarios-app/${u.id}/senha`, { senha });
          toast('Senha definida.');
          carregar();
        }),
        botaoIcone('lixo', 'Excluir', async () => {
          if (!await confirmar(`Excluir ${u.nome}`, 'O acesso dele ao app do cliente é removido.', 'Excluir')) return;
          await api.del(`${base(ctx)}/usuarios-app/${u.id}`);
          toast('Usuário excluído.');
          carregar();
        }, 'perigo')))), 'Nenhum usuário do app cadastrado ainda.'));
  }
  limpar(ctx.conteudo, el('section', { class: 'cartao grande' },
    el('p', { class: 'mudo', style: 'margin:0 0 6px' }, 'Pessoas que acessam o app do cliente e acompanham o próprio veículo, o plano e os seguros.'),
    el('p', { class: 'pequeno fraco', style: 'margin:0 0 14px' }, `Endereço do app do cliente: ${location.origin}${BASE}/cliente/`),
    el('div', { class: 'linha', style: 'justify-content:flex-end;margin-bottom:12px' },
      el('button', { class: 'btn primario', onclick: async () => { if (await formUsuario(ctx, veiculos)) carregar(); } }, 'Novo usuário')),
    lista));
  await carregar();
}

function formUsuario(ctx, veiculos, u) {
  const checks = veiculos.map((v) => marcar(placa(v.placa) + (v.descricao ? ` · ${v.descricao}` : ''), { value: v.id, checked: u ? u.veiculos.includes(v.id) : false }));
  return formModal(u ? `Editar ${u.nome}` : 'Novo usuário do app', () => [
    campo('Nome', { name: 'nome', required: true, maxlength: 80, value: u?.nome ?? '' }),
    el('div', { class: 'duas' },
      campo('E-mail', { name: 'email', type: 'email', maxlength: 120, value: u?.email ?? '' }),
      campo('CPF', { name: 'cpf', inputmode: 'numeric', maxlength: 14, value: u?.cpf ?? '' })),
    el('p', { class: 'pequeno fraco', style: 'margin:0' }, 'Informe e-mail e/ou CPF — é com um deles que o cliente entra.'),
    el('div', { class: 'duas' },
      campo('Telefone', { name: 'telefone', inputmode: 'tel', maxlength: 20, value: u?.telefone ?? '' }),
      campo(u ? 'Nova senha (opcional)' : 'Senha de acesso', { name: 'senha', type: 'text', maxlength: 60, placeholder: 'mínimo 6 caracteres' })),
    el('label', { class: 'rotulo-campo', style: 'display:block;margin-top:4px;font-weight:600;font-size:13px' }, 'Veículos que ele acompanha'),
    checks.length ? el('div', { class: 'lista-marcar' }, checks) : el('p', { class: 'mudo' }, 'Cadastre veículos primeiro em Frota → Veículos.'),
  ], (d) => {
    const corpo = { nome: d.nome, email: d.email, cpf: d.cpf, telefone: d.telefone, veiculos: lerMarcados(checks) };
    if (d.senha) corpo.senha = d.senha;
    if (u) corpo.ativo = true;
    return u ? api.put(`${base(ctx)}/usuarios-app/${u.id}`, corpo) : api.post(`${base(ctx)}/usuarios-app`, corpo);
  }, { rotulo: u ? 'Salvar' : 'Criar acesso' });
}

async function telaAtendimento(ctx) {
  const a = await api.get(`${base(ctx)}/atendimento`);
  const form = el('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button.primario');
    btn.disabled = true;
    try {
      await api.put(`${base(ctx)}/atendimento`, {
        plano_nome: form.plano_nome.value, atend_whatsapp: form.atend_whatsapp.value,
        atend_telefone: form.atend_telefone.value, atend_horario: form.atend_horario.value,
      });
      toast('Atendimento salvo.');
    } catch (err) { toast(err.message, true); } finally { btn.disabled = false; }
  } },
    campo('Nome do plano (aparece no app do cliente)', { name: 'plano_nome', maxlength: 60, value: a.plano_nome ?? '', placeholder: 'Rastreamento' }),
    el('div', { class: 'duas' },
      campo('WhatsApp do atendimento', { name: 'atend_whatsapp', inputmode: 'tel', maxlength: 30, value: a.atend_whatsapp ?? '', placeholder: '(41) 99999-9999' }),
      campo('Telefone / central', { name: 'atend_telefone', inputmode: 'tel', maxlength: 30, value: a.atend_telefone ?? '', placeholder: '0800 000 0000' })),
    campo('Horário de atendimento', { name: 'atend_horario', maxlength: 120, value: a.atend_horario ?? '', placeholder: 'Seg–sáb, 8h às 20h · emergência 24h' }),
    el('div', { class: 'linha', style: 'justify-content:flex-end;margin-top:6px' }, el('button', { class: 'btn primario' }, 'Salvar')));
  limpar(ctx.conteudo, cartao(null,
    el('p', { class: 'mudo', style: 'margin:0 0 14px' }, 'Esses dados aparecem no app do cliente, na área de Atendimento e no cartão do plano.'),
    form));
}

export const TELAS_CLIENTES = { 'usuarios-app': telaUsuariosApp, atendimento: telaAtendimento };
