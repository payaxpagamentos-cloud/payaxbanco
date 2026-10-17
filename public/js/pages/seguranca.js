import { api } from '../api.js';
import { html, $, $$, dataHora, numero, toast, confirmar } from '../ui.js';
import { tamanho } from './comum.js';

const PERFIL = { admin: 'Administrador', supervisor: 'Supervisor', analista: 'Analista' };

/** Segurança e backups (administrador). */
export default async function seguranca({ alvo, ativo }) {
  const carregar = async () => {
    const s = await api.get('/seguranca');
    if (!ativo()) return;
    const semEquipe = s.usuarios.filter((u) => u.ativo && !u.totp_ativo).length;
    alvo.innerHTML = String(html`
      <div class="page-head"><div><h1>Segurança e backups</h1><p class="muted">Verificação em duas etapas, cópias de segurança e tentativas de acesso.</p></div></div>
      <div class="grid grid-4">
        <div class="card kpi ${semEquipe ? 'vermelho' : 'verde'}"><div class="rotulo">Equipe sem 2 etapas</div><div class="valor">${numero(semEquipe)}</div><div class="sub">de ${numero(s.usuarios.filter((u) => u.ativo).length)} usuário(s) ativo(s)</div></div>
        <div class="card kpi"><div class="rotulo">Falhas de login (24 h)</div><div class="valor">${numero(s.falhas_login_24h)}</div><div class="sub">Equipe e Portal · detalhes na Auditoria</div></div>
        <div class="card kpi azul"><div class="rotulo">Último backup</div><div class="valor" style="font-size:18px">${s.backups[0] ? dataHora(s.backups[0].criado_em) : 'Nenhum'}</div>
          <div class="sub">Automático a cada ${s.backup_intervalo_horas} h · guarda ${s.backup_manter}</div></div>
        <div class="card kpi"><div class="rotulo">Documentos armazenados</div><div class="valor">${numero(s.documentos_armazenados)}</div><div class="sub">Fora do banco: inclua a pasta de arquivos no backup do servidor</div></div>
      </div>
      <div class="card" style="margin-top:16px"><div class="card-head"><h2>E-mail do sistema</h2>
        ${s.email.configurado ? html`<span class="badge ok">Configurado</span>` : html`<span class="badge warn">Não configurado</span>`}</div><div class="card-body">
        ${s.email.configurado ? html`<dl class="dl"><div><dt>Servidor</dt><dd>${s.email.servidor ?? 'modo de teste'}</dd></div><div><dt>Remetente</dt><dd>${s.email.remetente}</dd></div>
            <div><dt>Endereço nos links</dt><dd>${s.email.url_publica ?? html`<span class="neg">BPO_URL_PUBLICA não definida</span>`}</dd></div><div><dt>Enviados em 24 h</dt><dd>${numero(s.email.enviados_24h)}</dd></div></dl>
          ${s.email.falhas.length ? html`<div class="alerta perigo" style="margin-top:12px"><div><strong>Últimas falhas:</strong> ${s.email.falhas.map((f) => `${f.para} (${f.erro})`).join('; ')}</div></div>` : ''}
          <form id="form-teste" class="row" style="margin-top:14px"><input name="para" type="email" placeholder="seu@email.com.br" required style="max-width:320px"><button class="btn primario">Enviar e-mail de teste</button></form>`
          : html`<p class="muted" style="margin:0">Sem servidor de e-mail, os lembretes de cobrança, avisos de aprovação, acessos ao Portal e relatórios não são enviados automaticamente.
            Para ligar, preencha no arquivo <code>.env</code> do servidor: <code>BPO_SMTP_HOST</code>, <code>BPO_SMTP_PORTA</code>, <code>BPO_SMTP_USUARIO</code>, <code>BPO_SMTP_SENHA</code>,
            <code>BPO_EMAIL_REMETENTE</code> e <code>BPO_URL_PUBLICA</code>, e reinicie o sistema.</p>`}
      </div></div>
      <div class="card card-body" style="margin-top:16px"><label style="display:flex;gap:10px;align-items:center;margin:0;color:var(--text);font-size:14px">
        <input type="checkbox" id="exigir" style="width:18px;height:18px" ${s.exigir_2fa_equipe ? 'checked' : ''}>
        <span><strong>Exigir verificação em duas etapas de toda a equipe.</strong> <span class="muted">Quem não tiver ativado só consegue entrar depois de configurar o aplicativo autenticador.</span></span></label></div>
      <div class="grid grid-2" style="margin-top:16px;align-items:start">
        <div class="card"><div class="card-head"><h2>Equipe</h2></div><div class="table-wrap"><table><tbody>
          ${s.usuarios.map((u) => html`<tr><td><strong>${u.nome}</strong><div class="small muted">${u.email} · ${PERFIL[u.perfil]}${u.ativo ? '' : ' · inativo'}</div></td>
            <td>${u.totp_ativo ? html`<span class="badge ok">2 etapas ativa</span>` : html`<span class="badge warn">Só senha</span>`}</td>
            <td class="right">${u.totp_ativo ? html`<button class="btn sm" data-reset="${u.id}">Redefinir</button>` : ''}</td></tr>`)}</tbody></table></div></div>
        <div class="card"><div class="card-head"><h2>Backups do banco de dados</h2><button class="btn sm primario" id="backup">Fazer backup agora</button></div>
          <div class="table-wrap"><table><tbody>${s.backups.length ? s.backups.map((b) => html`<tr><td class="mono small">${b.nome}</td><td class="small">${tamanho(b.tamanho)}</td>
            <td class="right"><button class="btn sm" data-baixar="${b.nome}">Baixar</button></td></tr>`) : html`<tr><td class="vazio">Nenhum backup ainda.</td></tr>`}</tbody></table></div>
          <div class="card-body small muted" style="border-top:1px solid var(--border)">Copie os backups para outro local (outro servidor ou nuvem): um backup no mesmo disco não protege contra perda do servidor.</div></div>
      </div>
      <div class="card" style="margin-top:16px"><div class="card-head"><h2>Acessos ao Portal do Cliente</h2></div><div class="table-wrap"><table><tbody>
        ${s.portal.length ? s.portal.map((p) => html`<tr><td><strong>${p.nome}</strong><div class="small muted">${p.email} · ${p.empresa}</div></td>
          <td>${p.totp_ativo ? html`<span class="badge ok">2 etapas ativa</span>` : html`<span class="badge">Só senha</span>`}</td><td class="small">${p.ultimo_acesso ? `Último acesso ${dataHora(p.ultimo_acesso)}` : 'Nunca acessou'}</td></tr>`)
          : html`<tr><td class="vazio">Nenhum responsável com acesso ao Portal.</td></tr>`}</tbody></table></div></div>`);
    $('#exigir', alvo).addEventListener('change', async (e) => {
      try { await api.patch('/seguranca/config', { exigir_2fa_equipe: e.target.checked }); toast(e.target.checked ? 'Verificação em duas etapas obrigatória.' : 'Verificação em duas etapas opcional.'); }
      catch (err) { toast(err.message, 'erro'); e.target.checked = !e.target.checked; }
    });
    $('#form-teste', alvo)?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api.post('/seguranca/email-teste', { para: e.target.para.value }); toast(`E-mail de teste enviado para ${e.target.para.value}.`); carregar(); } catch (err) { toast(err.message, 'erro'); carregar(); }
    });
    $('#backup', alvo).addEventListener('click', async () => {
      try { const b = await api.post('/seguranca/backups'); toast(`Backup ${b.nome} gerado.`); carregar(); } catch (err) { toast(err.message, 'erro'); }
    });
    $$('[data-baixar]', alvo).forEach((b) => b.addEventListener('click', () => api.baixar(`/seguranca/backups/${b.dataset.baixar}`).catch((err) => toast(err.message, 'erro'))));
    $$('[data-reset]', alvo).forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmar('Redefinir verificação em duas etapas', 'Use quando a pessoa perdeu o celular. No próximo login, ela entra só com a senha e configura de novo.', 'Redefinir'))) return;
      try { await api.post(`/seguranca/usuarios/${b.dataset.reset}/reset-2fa`); toast('Verificação redefinida.'); carregar(); } catch (err) { toast(err.message, 'erro'); }
    }));
  };
  await carregar();
}
