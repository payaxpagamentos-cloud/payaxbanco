'use strict';

const { ErroEquipamento, http } = require('./base');

/*
 * MikroTik RouterOS como concentrador PPPoE, pela API REST (RouterOS 7+, serviço "www-ssl" ligado).
 *
 * O acesso do assinante é um /ppp/secret. Cortar NÃO é apagar: é desabilitar o secret e derrubar a sessão ativa,
 * para o assinante voltar exatamente como estava ao religar — e para a conta não sumir do equipamento quando o
 * motivo do corte for inadimplência. Apagar só acontece em "remover", no cancelamento do contrato.
 *
 * A velocidade vem do perfil (/ppp/profile) quando o plano tem um nome de perfil; sem perfil, vai como
 * rate-limit no próprio secret ("download/upload"), que o RouterOS aplica na conexão.
 */

const ID = '.id';

/** Caminho REST de um recurso pelo id interno do RouterOS (*1, *A3...). */
const rota = (base, id) => `/rest${base}/${encodeURIComponent(id)}`;

async function secretDoLogin(ctx, login) {
  const r = await http(ctx, { caminho: `/rest/ppp/secret?name=${encodeURIComponent(login)}` });
  const lista = Array.isArray(r.dados) ? r.dados : [];
  return lista.find((x) => x.name === login) ?? null;
}

async function ativoDoLogin(ctx, login) {
  const r = await http(ctx, { caminho: `/rest/ppp/active?name=${encodeURIComponent(login)}` });
  const lista = Array.isArray(r.dados) ? r.dados : [];
  return lista.find((x) => x.name === login) ?? null;
}

const kbps = (n) => (n ? `${Math.round(n)}k` : null);
/** rate-limit do RouterOS: "upload/download" na perspectiva do roteador (o que sobe do cliente vem primeiro). */
const limite = (desejado) => (desejado.upload_kbps && desejado.download_kbps ? `${kbps(desejado.upload_kbps)}/${kbps(desejado.download_kbps)}` : '');

/** Campos do secret que o sistema administra. O resto do que estiver no equipamento não é tocado. */
function camposDoSecret(servico, desejado) {
  const campos = {
    name: desejado.login,
    service: 'pppoe',
    comment: `Manager Provedor · contrato ${desejado.contrato_numero}`,
    disabled: desejado.situacao === 'cortado' ? 'true' : 'false',
  };
  if (desejado.senha) campos.password = desejado.senha;
  if (desejado.perfil) campos.profile = desejado.perfil;
  if (desejado.ip_fixo) campos['remote-address'] = desejado.ip_fixo;
  const rl = limite(desejado);
  if (rl && !desejado.perfil) campos['rate-limit'] = rl;
  return campos;
}

module.exports = {
  nome: 'mikrotik_routeros',
  rotulo: 'MikroTik RouterOS (API REST)',
  fabricante: 'MikroTik',
  papeis: ['concentrador'],
  protocolo: 'https',
  portaPadrao: 443,
  capacidades: ['identificar', 'ler', 'aplicar', 'cortar', 'religar', 'remover'],
  campos: [
    { nome: 'host', rotulo: 'IP de gerência', obrigatorio: true },
    { nome: 'porta', rotulo: 'Porta do serviço REST', ajuda: 'Normalmente 443 (www-ssl). Em laboratório, 80 com o serviço www.' },
    { nome: 'usuario', rotulo: 'Usuário', obrigatorio: true, ajuda: 'Usuário do RouterOS com permissão de escrita em ppp.' },
    { nome: 'senha', rotulo: 'Senha', tipo: 'password', obrigatorio: true },
  ],
  ajuda: 'Ligue o serviço www-ssl no RouterOS 7 (IP → Services) e use um usuário com os direitos "api", "read" e "write" no grupo ppp.',

  async identificar(ctx) {
    const r = await http(ctx, { caminho: '/rest/system/resource' });
    const d = Array.isArray(r.dados) ? r.dados[0] : r.dados;
    if (!d || !d.version) {
      throw new ErroEquipamento('O endereço respondeu, mas não parece um RouterOS com API REST. Confira a porta e o serviço www-ssl.', 'incompativel', { permanente: true });
    }
    const identidade = await http(ctx, { caminho: '/rest/system/identity' }).catch(() => null);
    return {
      modelo: d['board-name'] ?? 'RouterOS',
      versao: d.version,
      detalhe: [identidade?.dados?.name, d['architecture-name'], d.uptime ? `no ar há ${d.uptime}` : null].filter(Boolean).join(' · '),
    };
  },

  async ler(ctx, servico) {
    if (!servico.login) return { presente: false, motivo: 'Serviço ainda sem login definido.' };
    const secret = await secretDoLogin(ctx, servico.login);
    if (!secret) return { presente: false, login: servico.login, motivo: 'Não existe acesso com este login no concentrador.' };
    const ativo = await ativoDoLogin(ctx, servico.login);
    return {
      presente: true,
      login: secret.name,
      situacao: secret.disabled === 'true' ? 'cortado' : 'liberado',
      perfil: secret.profile ?? null,
      rate_limit: secret['rate-limit'] || null,
      ip_fixo: secret['remote-address'] || null,
      comentario: secret.comment ?? null,
      conectado: Boolean(ativo),
      // Só com sessão ativa o concentrador sabe dizer endereço e tempo; sem ela, fica nulo em vez de zero.
      ip_atual: ativo?.address ?? null,
      desde: ativo?.uptime ?? null,
      chamador: ativo?.['caller-id'] ?? null,
    };
  },

  async aplicar(ctx, servico, desejado) {
    if (!desejado.login) throw new ErroEquipamento('O serviço precisa de um login PPPoE antes de ser aplicado.', 'falha', { permanente: true });
    const secret = await secretDoLogin(ctx, desejado.login);
    const campos = camposDoSecret(servico, desejado);
    if (!secret) {
      const mudancas = [`criar acesso PPPoE ${desejado.login}`,
        desejado.perfil ? `perfil ${desejado.perfil}` : limite(desejado) ? `velocidade ${limite(desejado)}` : 'sem limite de velocidade definido',
        desejado.ip_fixo ? `IP fixo ${desejado.ip_fixo}` : null,
        desejado.situacao === 'cortado' ? 'já desabilitado (contrato bloqueado)' : null].filter(Boolean);
      if (ctx.ensaio) return { mudancas, ensaio: true };
      await http(ctx, { metodo: 'PUT', caminho: '/rest/ppp/secret', corpo: campos });
      return { mudancas };
    }
    // Já existe: só o que diverge é escrito, e a lista de mudanças é exatamente o que mudou.
    const diferencas = Object.entries(campos).filter(([k, valor]) => k !== 'password' && String(secret[k] ?? '') !== String(valor));
    const trocaSenha = Boolean(desejado.senha && ctx.trocarSenha);
    const mudancas = diferencas.map(([k, valor]) => `${k}: ${secret[k] ?? '(vazio)'} → ${valor}`);
    if (trocaSenha) mudancas.push('senha do acesso redefinida');
    if (!mudancas.length) return { mudancas: [], semMudanca: true };
    if (ctx.ensaio) return { mudancas, ensaio: true };
    const corpo = Object.fromEntries(diferencas);
    if (trocaSenha) corpo.password = desejado.senha;
    await http(ctx, { metodo: 'PATCH', caminho: rota('/ppp/secret', secret[ID]), corpo });
    if (campos.disabled === 'true') await derrubarSessao(ctx, desejado.login);
    return { mudancas };
  },

  async cortar(ctx, servico, { motivo } = {}) {
    const secret = await secretDoLogin(ctx, servico.login);
    if (!secret) throw new ErroEquipamento(`Não existe acesso ${servico.login} no concentrador para cortar.`, 'falha', { permanente: true });
    const jaCortado = secret.disabled === 'true';
    const ativo = await ativoDoLogin(ctx, servico.login);
    const mudancas = [];
    if (!jaCortado) mudancas.push(`desabilitar o acesso ${servico.login}${motivo ? ` (${motivo})` : ''}`);
    if (ativo) mudancas.push('derrubar a sessão em andamento');
    if (!mudancas.length) return { mudancas: [], semMudanca: true };
    if (ctx.ensaio) return { mudancas, ensaio: true };
    // O acesso não é apagado: desabilitado, ele volta igual ao religar.
    if (!jaCortado) await http(ctx, { metodo: 'PATCH', caminho: rota('/ppp/secret', secret[ID]), corpo: { disabled: 'true', comment: `${secret.comment ?? ''} · cortado: ${motivo ?? 'inadimplência'}`.trim().slice(0, 120) } });
    if (ativo) await derrubarSessao(ctx, servico.login);
    return { mudancas };
  },

  async religar(ctx, servico) {
    const secret = await secretDoLogin(ctx, servico.login);
    if (!secret) throw new ErroEquipamento(`Não existe acesso ${servico.login} no concentrador para religar.`, 'falha', { permanente: true });
    if (secret.disabled !== 'true') return { mudancas: [], semMudanca: true };
    const mudancas = [`habilitar o acesso ${servico.login}`];
    if (ctx.ensaio) return { mudancas, ensaio: true };
    await http(ctx, { metodo: 'PATCH', caminho: rota('/ppp/secret', secret[ID]),
      corpo: { disabled: 'false', comment: String(secret.comment ?? '').split(' · cortado:')[0] } });
    return { mudancas };
  },

  async remover(ctx, servico) {
    const secret = await secretDoLogin(ctx, servico.login);
    if (!secret) return { mudancas: [], semMudanca: true };
    const mudancas = [`apagar o acesso ${servico.login} do concentrador`];
    if (ctx.ensaio) return { mudancas, ensaio: true };
    await derrubarSessao(ctx, servico.login).catch(() => { /* sem sessão ativa */ });
    await http(ctx, { metodo: 'DELETE', caminho: rota('/ppp/secret', secret[ID]) });
    return { mudancas };
  },
};

/** Derruba a sessão PPPoE em andamento, para o corte valer na hora e não só na próxima reconexão. */
async function derrubarSessao(ctx, login) {
  const ativo = await ativoDoLogin(ctx, login);
  if (!ativo) return;
  await http(ctx, { metodo: 'DELETE', caminho: rota('/ppp/active', ativo[ID]) });
}
