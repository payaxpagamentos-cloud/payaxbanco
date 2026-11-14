/*
 Rastreador de Veículos — © 2026 Adriano Almeida. Todos os direitos reservados.
 Software proprietário. Uso mediante licença. É proibida a reprodução, distribuição, engenharia reversa ou
 criação de obra derivada sem autorização expressa do titular (Leis 9.609/98 e 9.610/98 — Brasil).
*/

/**
 * Teste de bloqueio da instalação: o sistema manda o corte, espera o rastreador confirmar, pergunta ao técnico se o motor
 * apagou; depois libera e pergunta se voltou. O resultado fica registrado no veículo ("bloqueio testado").
 */
import { api } from './api.js';
import { el, limpar, modal, toast, placa, etiqueta } from './ui.js';

const espera = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** Aviso no veículo enquanto o bloqueio não foi testado (ou reprovou). Só para rastreadores que cortam (GT06). */
export function etiquetaTeste(v) {
  if (v.protocolo !== 'gt06' || v.teste_bloqueio_ok === 1) return null;
  return etiqueta(v.teste_bloqueio_ok === 0 ? 'bloqueio reprovado' : 'bloqueio não testado', 'aviso');
}

export function testarBloqueio(ctx, v, aoTerminar) {
  const base = `/empresas/${ctx.empresaId}`;
  let cancelado = false;
  return modal(`Teste de bloqueio · ${placa(v.placa)}`, (fechar) => {
    const corpo = el('div', { class: 'teste-bloqueio' });
    const passo = (n, titulo, ...conteudo) => limpar(corpo, el('div', { class: 'pequeno mudo' }, `Passo ${n} de 3`), el('h3', { style: 'margin:4px 0 10px' }, titulo), ...conteudo);
    const botoes = (...b) => el('div', { class: 'linha entre', style: 'margin-top:16px;gap:10px' }, ...b);
    const btn = (texto, classe, onclick) => el('button', { type: 'button', class: `btn ${classe}`, onclick }, texto);
    const sair = () => { cancelado = true; fechar(); };

    // Manda o comando e espera o rastreador confirmar (até 2 min). Devolve { ok, resposta, motivo }.
    async function comandar(tipo, aguardando) {
      const c = await api.post(`${base}/veiculos/${v.id}/comandos`, { tipo, confirmacao: v.placa });
      if (c.status === 'aguardando_velocidade') return { ok: false, motivo: 'O veículo está andando. Pare o carro e comece o teste de novo.' };
      const inicio = Date.now();
      while (!cancelado && Date.now() - inicio < 120_000) {
        await espera(700);
        const lista = await api.get(`${base}/comandos?veiculo_id=${v.id}`);
        const x = c.id ? lista.find((y) => y.id === c.id) : lista.find((y) => y.tipo === tipo);
        if (!x) continue;
        if (x.status === 'confirmado') return { ok: true, resposta: x.resposta, id: x.id };
        if (['falhou', 'expirado', 'cancelado'].includes(x.status)) return { ok: false, motivo: `O rastreador não aceitou o comando (${x.resposta ?? x.status}).`, id: x.id };
        aguardando(x.status === 'pendente' ? (c.conectado === false ? 'O rastreador está sem conexão: o comando sai assim que ele conectar…' : 'Enviando ao rastreador…')
          : x.resposta ? 'O rastreador aceitou e vai cortar assim que tiver GPS (deixe o carro em lugar aberto)…' : 'Enviado: esperando o rastreador confirmar…');
      }
      return { ok: false, motivo: 'O rastreador não respondeu em 2 minutos. Confira se ele está conectado (Comunicação: agora).' };
    }
    const aguardo = (n, titulo) => { const t = el('p', { class: 'mudo' }, 'Enviando…'); passo(n, titulo, el('div', { class: 'carregando-linha' }), t, botoes(btn('Cancelar', '', sair))); return (msg) => { t.textContent = msg; }; };
    const pergunta = (n, titulo, texto, resposta) => new Promise((ok) => passo(n, titulo,
      resposta ? el('p', { class: 'pequeno' }, 'Resposta do rastreador: ', el('strong', {}, resposta)) : null,
      el('p', {}, texto), botoes(btn('Não', '', () => ok(false)), btn('Sim', 'primario', () => ok(true)))));

    async function rodar() {
      const corte = await comandar('bloquear', aguardo(1, 'Bloqueando…'));
      if (cancelado) return;
      if (!corte.ok) { passo(1, 'Não foi possível bloquear', el('p', {}, corte.motivo), botoes(btn('Fechar', 'primario', sair))); return; }
      const corteOk = await pergunta(1, 'O rastreador cortou', 'Com o carro ligado: o motor APAGOU (ou não dá partida)? Se o relé está na bomba de combustível, espere até 30 segundos.', corte.resposta);
      if (cancelado) return;
      const volta = await comandar('desbloquear', aguardo(2, 'Liberando…'));
      if (cancelado) return;
      const voltaOk = volta.ok && await pergunta(2, 'O rastreador liberou', 'Dê a partida: o carro VOLTOU a funcionar?', volta.resposta);
      if (cancelado) return;
      await api.post(`${base}/veiculos/${v.id}/teste-bloqueio`, { corte_ok: corteOk, volta_ok: voltaOk, comando_corte: corte.id, comando_volta: volta.id });
      const aprovado = corteOk && voltaOk;
      passo(3, aprovado ? 'Bloqueio aprovado ✅' : 'Bloqueio reprovado ❌',
        aprovado ? el('p', {}, 'O carro cortou e voltou. O teste ficou registrado no veículo.')
          : el('div', {},
            el('p', {}, !corteOk ? 'O rastreador obedeceu, mas o motor NÃO cortou: o relé não está no circuito certo.' : 'O carro não voltou a funcionar depois de liberar.'),
            el('p', { class: 'pequeno mudo' }, 'Peça ao instalador: 1) ouvir o clique do relé a cada comando; 2) o fio da bomba (ou da ignição) cortado e passando pelo relé — comum (30) e normalmente fechado (87a); 3) relé em bom estado. Depois, faça o teste de novo.')),
        botoes(el('span'), btn('Concluir', 'primario', () => { fechar(); aoTerminar?.(); })));
      toast(aprovado ? 'Bloqueio aprovado.' : 'Bloqueio reprovado: veja a orientação.', !aprovado);
    }

    passo(1, 'Antes de começar',
      el('ul', { class: 'mudo', style: 'margin:0 0 6px;padding-left:18px;line-height:1.7' },
        el('li', {}, 'Carro LIGADO e PARADO, em lugar aberto (o rastreador precisa de GPS).'),
        el('li', {}, 'Rastreador conectado (Comunicação: agora).'),
        el('li', {}, 'Alguém no carro para dizer se o motor apagou e se voltou.')),
      botoes(btn('Cancelar', '', sair), btn('Começar o teste', 'primario', () => rodar().catch((err) => {
        passo(1, 'Erro no teste', el('p', {}, err.message), botoes(btn('Fechar', 'primario', sair)));
      }))));
    return corpo;
  });
}
