import { api } from '../api.js';
import { el, painel, tabela, etq, etqDe, rotulo, dl, dataHora, desde, pode, formulario, confirmar, botao, toast, faixa, vazio, numero } from '../ui.js';

/*
 * Aparelho do assinante (CPE) dentro da ficha.
 *
 * O TR-069 é ao contrário do resto: quem liga é o aparelho. Então a tela nunca diz "Wi-Fi alterado" ao
 * receber a resposta da API — ela diz o que de fato aconteceu: ou o aparelho atendeu a chamada e está
 * aplicando, ou o pedido ficou guardado para o próximo contato dele. Só a confirmação do aparelho vira
 * "confirmado", e é por isso que a lista de pedidos fica à vista.
 */

/** Nome do parâmetro no retrato do aparelho, nos dois dialetos. */
const leitura = (p, sufixos) => {
  if (!p) return null;
  const chave = Object.keys(p).find((k) => sufixos.some((s) => k.endsWith(s)));
  return chave ? p[chave] : null;
};
const ssidAtual = (p) => leitura(p, ['WLANConfiguration.1.SSID', 'WiFi.SSID.1.SSID']);
const canalAtual = (p) => leitura(p, ['WLANConfiguration.1.Channel', 'WiFi.Radio.1.Channel']);
const ligadoAtual = (p) => leitura(p, ['WLANConfiguration.1.Enable', 'WiFi.SSID.1.Enable']);
const conectados = (p) => leitura(p, ['TotalAssociations', 'AssociatedDeviceNumberOfEntries']);

export function painelWifi(cpe, recarregar, { titulo = 'Wi-Fi do assinante' } = {}) {
  if (!cpe) {
    return painel(titulo, vazio('Nenhum aparelho conversou com o ACS neste contrato.',
      'O roteador precisa estar apontado para o ACS do provedor. Enquanto não ligar, não dá para mexer no Wi-Fi daqui.'));
  }
  const pendentes = cpe.tarefas.filter((t) => ['pendente', 'entregue'].includes(t.situacao));
  const p = cpe.parametros;

  const pedir = async (caminho, corpo, botaoTexto) => {
    const r = await api.post(`/cpes/${cpe.id}${caminho}`, corpo);
    toast(r.aviso ?? botaoTexto, !r.chamada?.atendeu);
    recarregar();
  };

  return painel(titulo, el('div', {},
    cpe.chamado_configurado
      ? null
      : faixa('O ACS ainda não gravou a credencial de chamada neste aparelho. Até lá, toda mudança espera o próximo contato dele.', 'aviso', 'info'),
    pendentes.length
      ? faixa(`${pendentes.length} pedido(s) aguardando o aparelho: ${pendentes.map((t) => t.descricao ?? rotulo('rpcCpe', t.rpc)).join(' · ')}`, 'aviso', 'relogio')
      : null,
    dl([
      ['Aparelho', [cpe.fabricante, cpe.modelo].filter(Boolean).join(' ') || cpe.serial],
      ['Série', cpe.serial],
      ['Firmware', cpe.versao_firmware],
      ['Rede (SSID)', ssidAtual(p) ?? el('span', { class: 'fraco' }, 'ainda não lido do aparelho')],
      ['Canal', canalAtual(p) ?? el('span', { class: 'fraco' }, '—')],
      ['Wi-Fi ligado', ligadoAtual(p) === null ? el('span', { class: 'fraco' }, '—') : (/^(1|true)$/i.test(String(ligadoAtual(p))) ? 'sim' : 'não')],
      conectados(p) !== null ? ['Aparelhos conectados', numero(Number(conectados(p)))] : null,
      ['Último contato', cpe.ultimo_contato ? `${dataHora(cpe.ultimo_contato)} (${desde(cpe.ultimo_contato)})` : 'nunca'],
      ['Chamada do ACS', cpe.chamado_configurado ? 'configurada: dá para aplicar na hora' : 'ainda não configurada'],
    ]),
    el('div', { class: 'form-acoes', style: 'justify-content:flex-start;flex-wrap:wrap' },
      pode('contratos.editar') ? botao('Alterar Wi-Fi', () => alterarWifi(cpe, recarregar), { tipo: 'pequeno', ic: 'config' }) : null,
      pode('contratos.ver') ? botao('Ler do aparelho', () => pedir('/ler', {}, 'Leitura pedida.'), { tipo: 'secundario pequeno', ic: 'atualizar' }) : null,
      pode('contratos.editar') ? botao('Reiniciar', async () => {
        if (!(await confirmar('Reiniciar o aparelho do assinante',
          'O assinante fica sem conexão por cerca de um minuto. Avise antes de confirmar.', 'Reiniciar'))) return;
        await pedir('/reiniciar', {}, 'Reinício pedido.');
      }, { tipo: 'perigo pequeno' }) : null),
    cpe.tarefas.length
      ? el('details', { class: 'bloco-expansivel', style: 'margin-top:12px' }, el('summary', {}, `Pedidos ao aparelho (${cpe.tarefas.length})`),
        tabela([
          { titulo: 'Pedido', valor: (t) => el('div', {}, el('div', { class: 'forte' }, t.descricao ?? rotulo('rpcCpe', t.rpc)),
            el('div', { class: 'fraco' }, [rotulo('rpcCpe', t.rpc), t.usuario_nome ?? rotulo('origemAcao', t.origem === 'usuario' ? 'usuario' : 'sistema')].join(' · '))) },
          { titulo: 'Quando', valor: (t) => el('div', {}, dataHora(t.criado_em),
            t.concluido_em ? el('div', { class: 'fraco' }, `respondido ${dataHora(t.concluido_em)}`) : null) },
          { titulo: 'Situação', valor: (t) => el('div', {}, etqDe('situacaoTarefaCpe', t.situacao),
            t.erro ? el('div', { class: 'fraco' }, t.erro) : t.resultado?.aplicado ? el('div', { class: 'fraco' }, `aplicado ${t.resultado.aplicado}`) : null) },
          { titulo: '', valor: (t) => (pode('contratos.editar') && ['pendente', 'entregue'].includes(t.situacao)
            ? botao('Cancelar', async () => { await api.post(`/cpes/tarefas/${t.id}/cancelar`); toast('Pedido cancelado.'); recarregar(); }, { tipo: 'fantasma pequeno' })
            : '') },
        ], cpe.tarefas))
      : null));
}

function alterarWifi(cpe, depois) {
  const p = cpe.parametros;
  return formulario('Alterar o Wi-Fi do assinante', [
    { nome: 'ssid', rotulo: 'Nome da rede (SSID)', valor: ssidAtual(p) ?? '', inteiro: true,
      ajuda: 'Até 32 caracteres, sem acento: o aparelho recusa o que não couber. Em branco, o nome não é mexido.' },
    { nome: 'senha', rotulo: 'Senha do Wi-Fi', tipo: 'password', autocomplete: 'new-password', inteiro: true,
      ajuda: 'De 8 a 63 caracteres (regra do WPA2). Em branco, a senha não é mexida.' },
    { nome: 'canal', rotulo: 'Canal', tipo: 'number', valor: canalAtual(p) ?? '', ajuda: 'Zero deixa o aparelho escolher sozinho. Em branco, o canal não é mexido.' },
  ], {
    rotuloEnviar: 'Enviar ao aparelho',
    antes: faixa(cpe.chamado_configurado
      ? 'O sistema vai pedir ao aparelho que ligue agora. Se ele estiver desligado ou inacessível, o pedido fica guardado e é aplicado no próximo contato.'
      : 'Este aparelho ainda não tem a credencial de chamada: o pedido ficará guardado até ele ligar sozinho.', '', 'info'),
    enviar: async (d) => {
      const r = await api.post(`/cpes/${cpe.id}/wifi`, { ssid: d.ssid || undefined, senha: d.senha || undefined, canal: d.canal === '' ? undefined : d.canal });
      toast(r.aviso, !r.chamada.atendeu);
      depois?.();
      return r;
    },
  });
}

/** Lista de aparelhos, para a tela de Provisionamento. */
export function listaCpes(itens, ir) {
  return painel('Aparelhos dos assinantes (TR-069)', tabela([
    { titulo: 'Aparelho', valor: (c) => el('div', {}, el('div', { class: 'forte' }, [c.fabricante, c.modelo].filter(Boolean).join(' ') || c.serial),
      el('div', { class: 'fraco' }, `${c.serial}${c.versao_firmware ? ` · ${c.versao_firmware}` : ''}`)) },
    { titulo: 'Assinante', valor: (c) => (c.assinante_nome
      ? el('div', {}, c.assinante_nome, el('div', { class: 'fraco' }, `contrato #${c.contrato_numero}${c.login ? ` · ${c.login}` : ''}`))
      : etq('Sem vínculo', 'aviso')) },
    { titulo: 'Rede', valor: (c) => ssidAtual(c.parametros) ?? el('span', { class: 'fraco' }, 'não lida') },
    { titulo: 'Último contato', valor: (c) => (c.ultimo_contato ? el('div', {}, desde(c.ultimo_contato), el('div', { class: 'fraco' }, c.ultimo_evento ?? '')) : el('span', { class: 'fraco' }, 'nunca')) },
    { titulo: 'Chamada', valor: (c) => (c.chamado_configurado ? etq('Aplica na hora', 'ok') : etq('Só no contato dele', 'aviso')) },
  ], itens, {
    vazioTexto: 'Nenhum aparelho conversou com o ACS ainda.',
    aoClicar: (c) => (c.assinante_id ? ir(`#/assinantes/${c.assinante_id}?aba=contratos`) : null),
  }), { semCorpo: true });
}
