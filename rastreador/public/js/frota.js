/** Frota: nota dos motoristas e ranking, custo em reais e os equipamentos (a ficha do J16 com saúde, consultas e ajustes). */
import { api, qs, baixar } from './api.js';
import { el, limpar, dinheiro, dataHora, desde, km, kmh, placa, inteiro, toast, acao, campo, escolha, modal, perguntar, repetir, etiqueta, icone,
  hojeLocal, somarDias } from './ui.js';
import { cartao, indicador, tabela, td, botao, acoesTopo, linhaDado } from './comum.js';

const base = (ctx) => `/empresas/${ctx.empresaId}`;
const link = (ctx, tela) => `#/empresa/${ctx.empresaId}/${tela}`;
const horasMin = (s) => { const t = Math.round(s ?? 0); const h = Math.floor(t / 3600); const m = Math.round((t % 3600) / 60); return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`; };

// ---------- Período (atalhos) ----------
function periodos() {
  const hoje = hojeLocal();
  const d = new Date(`${hoje}T12:00:00`);
  const semana = somarDias(hoje, -((d.getDay() + 6) % 7));
  const inicioMes = `${hoje.slice(0, 7)}-01`;
  const fimMesPassado = somarDias(inicioMes, -1);
  return {
    semana: ['Esta semana', semana, hoje], mes: ['Este mês', inicioMes, hoje], trinta: ['Últimos 30 dias', somarDias(hoje, -29), hoje],
    passado: ['Mês passado', `${fimMesPassado.slice(0, 7)}-01`, fimMesPassado],
  };
}
/** Chips de período; chama fn(de, ate) ao trocar. */
function seletorPeriodo(inicial, fn) {
  const p = periodos();
  let atual = inicial;
  const raiz = el('div', { class: 'chips', role: 'group', 'aria-label': 'Período' });
  const desenhar = () => limpar(raiz, Object.entries(p).map(([k, [rot]]) => el('button', { type: 'button', class: `chip${k === atual ? ' on' : ''}`,
    onclick: () => { atual = k; desenhar(); fn(p[k][1], p[k][2]); } }, rot)));
  desenhar();
  return { raiz, de: p[inicial][1], ate: p[inicial][2] };
}

// ---------- Nota do motorista ----------
const tomNota = (n) => (n === null || n === undefined ? '' : n >= 85 ? 'ok' : n >= 70 ? 'aviso' : 'erro');
const selo = (n) => el('span', { class: `nota tom-${tomNota(n)}` }, n ?? '—');
const MOTIVOS = { velocidade: 'Excesso de velocidade', horario: 'Uso fora do horário', ociosidade: 'Motor ligado parado', bruscos: 'Variações bruscas' };
const MAX_DESCONTO = { velocidade: 40, horario: 20, ociosidade: 20, bruscos: 20 };

function detalheNota(x, titulo) {
  modal(titulo, (fechar) => [
    el('div', { class: 'nota-grande' }, selo(x.nota), el('div', {}, el('strong', {}, `${x.nota} de 100`),
      el('div', { class: 'pequeno mudo' }, `${km((x.km ?? 0) * 1000)} rodados${x.veiculos ? ` · ${[].concat(x.veiculos).map(placa).join(', ')}` : ''}`))),
    el('div', { class: 'descontos' }, Object.entries(MOTIVOS).map(([k, rot]) => {
      const valor = x.descontos?.[k] ?? 0;
      return el('div', { class: 'desconto' }, el('div', { class: 'linha entre' }, el('span', {}, rot), el('strong', { class: 'num' }, valor ? `−${String(valor).replace('.', ',')}` : '0')),
        el('div', { class: 'trilho' }, el('span', { style: `width:${Math.min(100, (valor / MAX_DESCONTO[k]) * 100)}%` })));
    })),
    el('div', { class: 'chaves' },
      linhaDado('Excessos de velocidade', inteiro(x.excessos)), linhaDado('Tempo acima do limite', horasMin(x.acima_s)),
      linhaDado('Uso fora do horário', inteiro(x.fora_horario)), linhaDado('Motor ligado parado', horasMin(x.ocioso_s)),
      linhaDado('Variações bruscas', inteiro(x.bruscos))),
    el('p', { class: 'pequeno mudo' }, 'Variações bruscas são estimadas pela mudança de velocidade entre posições próximas: o aparelho não mede a freada.'),
    el('div', { class: 'linha', style: 'justify-content:flex-end' }, el('button', { class: 'btn primario', onclick: () => fechar() }, 'Fechar')),
  ]);
}

async function telaRanking(ctx) {
  const corpo = el('div', { class: 'coluna', style: 'gap:16px' });
  const per = seletorPeriodo('mes', (de, ate) => carregar(de, ate));
  let atual = [per.de, per.ate];
  const pdf = el('button', { class: 'btn', onclick: (e) => acao(e.currentTarget, () => baixar(`${base(ctx)}/relatorios/periodo.pdf${qs({ de: atual[0], ate: atual[1], conteudo: 'motoristas' })}`,
    `nota-motoristas-${atual[0]}.pdf`)) }, icone('baixar'), 'PDF');
  limpar(ctx.conteudo, acoesTopo(per.raiz, pdf), corpo);
  async function carregar(de, ate) {
    atual = [de, ate];
    const d = await api.get(`${base(ctx)}/desempenho${qs({ de, ate })}`);
    const melhor = d.ranking[0];
    const pior = d.ranking.length > 1 ? d.ranking.at(-1) : null;
    limpar(corpo,
      el('div', { class: 'grade' },
        indicador('Nota média', d.totais.nota_media ?? '—', 'de 0 a 100', tomNota(d.totais.nota_media), 'dashboard'),
        indicador('Melhor motorista', melhor ? melhor.nome : '—', melhor ? `nota ${melhor.nota}` : 'sem motoristas no período', 'ok', 'motoristas'),
        indicador('Precisa de atenção', pior ? pior.nome : '—', pior ? `nota ${pior.nota}` : '—', pior && pior.nota < 70 ? 'erro' : '', 'alertas'),
        indicador('Rodados', km(d.totais.km * 1000), `${data2(de)} a ${data2(ate)}`, '', 'rota')),
      cartao('Ranking dos motoristas', tabela(['#', 'Motorista', '>Nota', 'Veículos', '>Km', '>Excessos', '>Fora do horário', '>Ligado parado', '>Bruscos', '>Custo', '^'],
        d.ranking.map((m, i) => el('tr', {},
          td(el('span', { class: `posicao${i < 3 ? ` p${i + 1}` : ''}` }, i + 1)), td(el('strong', {}, m.nome)), td(selo(m.nota), 'dir'),
          td(m.veiculos.map(placa).join(', ')), td(inteiro(Math.round(m.km)), 'dir num'), td(inteiro(m.excessos), 'dir num'), td(inteiro(m.fora_horario), 'dir num'),
          td(horasMin(m.ocioso_s), 'dir num'), td(inteiro(m.bruscos), 'dir num'), td(m.custo_centavos ? dinheiro(m.custo_centavos) : '—', 'dir num'),
          el('td', { class: 'acoes' }, botao('Detalhe', '', () => detalheNota(m, m.nome))))),
        'Nenhum motorista com veículo no período. Defina o motorista fixo de cada veículo em Frota → Veículos.')),
      cartao('Nota por veículo', tabela(['Veículo', 'Motorista', '>Nota', '>Km', '>Vel. máx.', '>Excessos', '>Ligado parado', '^'], d.veiculos.map((x) => el('tr', {},
        td([el('strong', {}, placa(x.placa)), x.descricao ? el('div', { class: 'pequeno mudo' }, x.descricao) : null]), td(x.motorista ?? '—'), td(selo(x.nota), 'dir'),
        td(inteiro(Math.round(x.km)), 'dir num'), td(kmh(x.velocidade_max_kmh), 'dir num'), td(inteiro(x.excessos), 'dir num'), td(horasMin(x.ocioso_s), 'dir num'),
        el('td', { class: 'acoes' }, botao('Detalhe', '', () => detalheNota(x, placa(x.placa)))))), 'Nenhum veículo ativo.')),
      el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'Perde pontos: excesso de velocidade (por alerta e por minuto acima do limite), uso fora do horário, motor ligado parado por mais de 5 minutos e variações bruscas de velocidade.'));
  }
  await carregar(per.de, per.ate);
}
const data2 = (d) => d.split('-').reverse().slice(0, 2).join('/');

// ---------- Custos ----------
async function telaCustos(ctx) {
  const corpo = el('div', { class: 'coluna', style: 'gap:16px' });
  const per = seletorPeriodo('mes', (de, ate) => carregar(de, ate));
  let atual = [per.de, per.ate];
  const pdf = el('button', { class: 'btn', onclick: (e) => acao(e.currentTarget, () => baixar(`${base(ctx)}/relatorios/periodo.pdf${qs({ de: atual[0], ate: atual[1], conteudo: 'custos,frota' })}`,
    `custos-${atual[0]}.pdf`)) }, icone('baixar'), 'PDF');
  limpar(ctx.conteudo, acoesTopo(per.raiz, pdf), corpo);
  async function carregar(de, ate) {
    atual = [de, ate];
    const d = await api.get(`${base(ctx)}/desempenho${qs({ de, ate })}`);
    const consumo = new Map(d.veiculos.map((x) => [x.id, x.consumo_km_l]));
    const t = d.totais;
    const porKm = t.custo_centavos && t.km ? Math.round(t.custo_centavos / t.km) : null;
    limpar(corpo,
      !d.preco_combustivel_centavos ? el('p', { class: 'aviso' }, 'Informe o preço do combustível em ', el('a', { href: link(ctx, 'configuracoes') }, 'Configurações → Geral'), ' para calcular o custo.') : null,
      t.sem_consumo ? el('p', { class: 'aviso' }, `${t.sem_consumo} veículo(s) sem o consumo médio (km/l): edite em `, el('a', { href: link(ctx, 'veiculos') }, 'Frota → Veículos'), '.') : null,
      el('div', { class: 'grade' },
        indicador('Custo de combustível', t.custo_centavos !== null ? dinheiro(t.custo_centavos) : '—', `${data2(de)} a ${data2(ate)}`, '', 'carteira'),
        indicador('Gasto com motor parado', t.custo_ocioso_centavos !== null ? dinheiro(t.custo_ocioso_centavos) : '—', 'ligado sem andar (mais de 5 min)', t.custo_ocioso_centavos ? 'aviso' : '', 'pausa'),
        indicador('Rodados', km(t.km * 1000), `${inteiro(d.veiculos.length)} veículo(s)`, '', 'rota'),
        indicador('Custo por km', porKm !== null ? dinheiro(porKm) : '—', `combustível a ${d.preco_combustivel_centavos ? dinheiro(d.preco_combustivel_centavos) : '—'}/litro`, '', 'dashboard')),
      cartao('Por veículo', tabela(['Veículo', 'Motorista', '>Km', '>Consumo', '>Litros', '>Ligado parado', '>Custo parado', '>Custo total', '>R$/km'], d.veiculos.map((x) => el('tr', {},
        td([el('strong', {}, placa(x.placa)), x.descricao ? el('div', { class: 'pequeno mudo' }, x.descricao) : null]), td(x.motorista ?? '—'),
        td(inteiro(Math.round(x.km)), 'dir num'), td(consumo.get(x.id) ? `${String(consumo.get(x.id)).replace('.', ',')} km/l` : etiqueta('sem consumo', 'aviso'), 'dir num'),
        td(x.litros !== null ? `${String(x.litros).replace('.', ',')} L` : '—', 'dir num'), td(horasMin(x.ocioso_s), 'dir num'),
        td(x.custo_ocioso_centavos !== null ? dinheiro(x.custo_ocioso_centavos) : '—', 'dir num'), td(x.custo_centavos !== null ? el('strong', {}, dinheiro(x.custo_centavos)) : '—', 'dir num'),
        td(x.custo_centavos && x.km ? dinheiro(Math.round(x.custo_centavos / x.km)) : '—', 'dir num'))), 'Nenhum veículo ativo.')),
      el('p', { class: 'pequeno mudo', style: 'margin:0' }, 'Custo = km ÷ consumo médio × preço do combustível, mais as horas de motor ligado parado × litros por hora × preço. '
        + 'O consumo fica no cadastro de cada veículo; o preço e os litros por hora parado, em Configurações → Geral.'));
  }
  await carregar(per.de, per.ate);
}

// ---------- Equipamentos e a ficha do J16 ----------
const barrasSinal = (n) => {
  if (n === null || n === undefined) return el('span', { class: 'mudo' }, '—');
  const nivel = Math.max(0, Math.min(4, Number(n)));
  return el('span', { class: 'sinal', title: `Sinal ${nivel} de 4`, 'aria-label': `Sinal ${nivel} de 4` }, [1, 2, 3, 4].map((i) => el('i', { class: i <= nivel ? 'on' : '' })));
};
const SINAL = ['sem sinal', 'fraco', 'regular', 'bom', 'forte'];

/** Ficha do equipamento: saúde, consultas e (para a equipe da plataforma) os ajustes do J16. */
export async function abrirFicha(ctx, veiculoId) {
  const caminho = `${base(ctx)}/veiculos/${veiculoId}/equipamento`;
  let f = await api.get(caminho);
  const plataforma = ctx.master;
  const gestor = !ctx.somenteLeitura;
  const gt06 = f.rastreador.protocolo === 'gt06';
  const corpo = el('div', { class: 'ficha' });
  const enviar = async (botaoEl, ajuste, valor, extra = {}) => acao(botaoEl, async () => {
    const r = await api.post(caminho, { ajuste, valor, ...extra });
    toast(r.comandos?.length ? `${r.comandos.length} comando(s) na fila: vão assim que o rastreador conectar. A resposta aparece abaixo.` : 'Ajuste salvo.');
    f = await api.get(caminho);
    desenhar();
  });
  const btn = (texto, ajuste, valor, classe = '') => {
    const b = el('button', { type: 'button', class: `btn pequeno ${classe}` }, texto);
    b.addEventListener('click', () => enviar(b, ajuste, valor));
    return b;
  };
  const par = (rotulo, ajuste, ligar = 'Ligar', desligar = 'Desligar', descricao = '') => el('div', { class: 'ajuste' },
    el('div', {}, el('strong', {}, rotulo), descricao ? el('div', { class: 'pequeno mudo' }, descricao) : null),
    plataforma ? el('div', { class: 'linha' }, btn(ligar, ajuste, true), btn(desligar, ajuste, false)) : null);

  function desenhar() {
    const r = f.rastreador;
    const s = r.saude ?? {};
    const v = f.veiculo;
    const online = r.conectado || (r.ultima_comunicacao && Date.now() - Date.parse(r.ultima_comunicacao) < 10 * 60_000);
    const secao = (titulo, ...filhos) => el('section', { class: 'ficha-secao' }, el('h3', {}, titulo), filhos);
    limpar(corpo,
      el('div', { class: 'ficha-topo' },
        el('div', {}, el('strong', {}, r.modelo ?? 'Rastreador'), el('div', { class: 'pequeno mudo mono' }, `IMEI ${r.imei}`)),
        etiqueta(r.conectado ? 'conectado agora' : online ? 'comunicando' : 'sem comunicação', r.conectado || online ? 'ok' : 'erro')),
      el('div', { class: 'saude' },
        el('div', { class: 'dado' }, el('span', {}, 'Sinal 4G'), el('strong', {}, barrasSinal(r.sinal_gsm ?? s.sinal), ' ', SINAL[r.sinal_gsm ?? s.sinal] ?? '')),
        el('div', { class: 'dado' }, el('span', {}, 'Bateria do carro'), el('strong', {}, v.tensao !== null && v.tensao !== undefined ? `${Number(v.tensao).toFixed(1).replace('.', ',')} V` : '—')),
        el('div', { class: 'dado' }, el('span', {}, 'Bateria interna'), el('strong', {}, s.bateria_v ? `${Number(s.bateria_v).toFixed(2).replace('.', ',')} V` : '—')),
        el('div', { class: 'dado' }, el('span', {}, 'GPS'), el('strong', {}, s.gps ?? '—')),
        el('div', { class: 'dado' }, el('span', {}, 'Ignição'), el('strong', {}, v.ignicao === 1 ? 'ligada' : v.ignicao === 0 ? 'desligada' : '—')),
        el('div', { class: 'dado' }, el('span', {}, 'Relé (corte)'), el('strong', {}, v.bloqueado ? 'cortado' : 'liberado')),
        el('div', { class: 'dado' }, el('span', {}, 'Intervalo'), el('strong', {}, s.timer ? `${s.timer[0]} s / ${s.timer[1]} s` : f.perfis[r.perfil]?.nome ?? '—')),
        el('div', { class: 'dado' }, el('span', {}, 'Firmware'), el('strong', {}, r.firmware ?? s.firmware ?? '—')),
        el('div', { class: 'dado' }, el('span', {}, 'Comunicação'), el('strong', {}, desde(r.ultima_comunicacao)))),
      el('p', { class: 'pequeno mudo', style: 'margin:0' }, r.saude_em ? `Dados da última consulta: ${dataHora(r.saude_em)}.` : 'Ainda sem consulta: toque em "Consultar estado".'),
      gt06 && gestor ? secao('Consultas',
        el('div', { class: 'linha' }, btn('Consultar estado', 'status'), btn('Consultar configuração', 'parametros'), btn('Configuração completa', 'completo'),
          btn('Pedir link do mapa', 'link'), el('span', { class: 'sep-v' }),
          (() => { const b = el('button', { type: 'button', class: 'btn pequeno' }, 'Reiniciar o aparelho'); b.addEventListener('click', async () => {
            if (await perguntar('Reiniciar o rastreador', 'Ele fica alguns segundos fora do ar. Digite REINICIAR para confirmar:') !== 'REINICIAR') return;
            enviar(b, 'reiniciar');
          }); return b; })())) : null,
      gt06 ? secao('Rastreamento',
        el('div', { class: 'perfis' }, Object.entries(f.perfis).map(([k, p]) => {
          const b = el('button', { type: 'button', class: `perfil${r.perfil === k ? ' on' : ''}`, disabled: !plataforma || null },
            el('strong', {}, p.nome), el('span', { class: 'pequeno mudo' }, p.descricao));
          if (plataforma) b.addEventListener('click', () => enviar(b, 'perfil', k));
          return b;
        })),
        par('Envio nas curvas', 'curvas', 'Ligar', 'Desligar', 'Manda posição ao virar mais de 15°: o trajeto segue a rua de verdade.'),
        el('div', { class: 'ajuste' }, el('div', {}, el('strong', {}, 'Limite de velocidade no aparelho'),
          el('div', { class: 'pequeno mudo' }, v.limite_velocidade_kmh ? `Grava ${v.limite_velocidade_kmh} km/h (o limite do cadastro) como reserva do alerta do servidor.` : 'Defina o limite no cadastro do veículo.')),
        plataforma && v.limite_velocidade_kmh ? el('div', { class: 'linha' }, btn('Gravar', 'velocidade', v.limite_velocidade_kmh), btn('Desligar', 'velocidade', 0)) : null)) : null,
      gt06 ? secao('Alarmes do aparelho',
        par('Corte de energia e violação', 'alarme_energia', 'Ligar', 'Desligar', 'Vira o alerta "bateria desconectada" e vai para o WhatsApp.'),
        par('Bateria baixa', 'alarme_bateria'),
        par('Vibração', 'alarme_vibracao', 'Ligar', 'Desligar', 'Aviso de mexida com o carro parado (tentativa de arrombamento).')) : null,
      gt06 ? secao('Segurança',
        par('Anti-jammer', 'anti_jammer', 'Ligar', 'Desligar', 'Nos lotes que aceitam: ao detectar bloqueador de sinal, corta sozinho, só abaixo de 20 km/h.'),
        el('div', { class: 'ajuste' }, el('div', {}, el('strong', {}, 'Números de emergência'), el('div', { class: 'pequeno mudo' }, 'Celular do dono gravado no aparelho, para SMS quando a internet falhar.')),
          plataforma ? el('div', { class: 'linha' }, ...['numero_central', 'numero_sos'].map((aj) => {
            const b = el('button', { type: 'button', class: 'btn pequeno' }, aj === 'numero_central' ? 'Central' : 'SOS');
            b.addEventListener('click', async () => {
              const n = await perguntar(aj === 'numero_central' ? 'Número da central' : 'Número de SOS', 'Celular com DDD (deixe vazio para apagar)', { obrigatorio: false });
              if (n !== null) enviar(b, aj, n);
            });
            return b;
          })) : null)) : null,
      gt06 && plataforma ? secao('Instalação e energia',
        par('Ignição virtual', 'ignicao_virtual', 'Ligar', 'Usar o fio', 'Para instalação sem o fio da ignição: o aparelho deduz pelo movimento.'),
        par('LEDs do aparelho', 'leds', 'Acender', 'Apagar', 'Apagados, o rastreador fica invisível depois de instalado.'),
        el('div', { class: 'ajuste' }, el('div', {}, el('strong', {}, 'Modo sono'), el('div', { class: 'pequeno mudo' }, 'Online mantém os comandos chegando; economia poupa mais bateria, mas o aparelho só ouve SMS.')),
          el('div', { class: 'linha' }, btn('Online', 'sono', 'online'), btn('Economia', 'sono', 'economia'))),
        el('div', { class: 'ajuste' }, el('div', {}, el('strong', {}, 'Fuso horário'), el('div', { class: 'pequeno mudo' }, 'Mantém o aparelho em UTC; o sistema converte para Brasília.')),
          el('div', { class: 'linha' }, btn('Gravar UTC', 'fuso'))),
        el('div', { class: 'ajuste' }, el('div', {}, el('strong', {}, 'Sentido do relé'), el('div', { class: 'pequeno mudo' }, r.rele_invertido ? 'Invertido: corta com RELAY,0.' : 'Normal: corta com RELAY,1.')),
          el('div', { class: 'linha' }, btn(r.rele_invertido ? 'Voltar ao normal' : 'Inverter', 'rele_invertido', !r.rele_invertido))),
        el('div', { class: 'ajuste perigo-zona' }, el('div', {}, el('strong', {}, 'Conexão e fábrica'), el('div', { class: 'pequeno mudo' }, 'Um erro aqui tira o aparelho do ar. Confira antes de enviar.')),
          el('div', { class: 'linha' },
            (() => { const b = el('button', { type: 'button', class: 'btn pequeno' }, 'Servidor'); b.addEventListener('click', async () => {
              const t = await perguntar('Servidor do rastreador', 'Endereço:porta (ex.: 179.199.151.187:5023)');
              const m = /^([\w.-]+):(\d{2,5})$/.exec(t ?? '');
              if (!m) { if (t) toast('Use endereço:porta.', true); return; }
              enviar(b, 'servidor', { host: m[1], porta: Number(m[2]) });
            }); return b; })(),
            (() => { const b = el('button', { type: 'button', class: 'btn pequeno' }, 'APN'); b.addEventListener('click', async () => {
              const t = await perguntar('APN do chip', 'APN da operadora (ex.: zap.vivo.com.br)');
              if (t) enviar(b, 'apn', { apn: t });
            }); return b; })(),
            (() => { const b = el('button', { type: 'button', class: 'btn pequeno perigo' }, 'Padrão de fábrica'); b.addEventListener('click', async () => {
              const conf = await perguntar('Padrão de fábrica', `Apaga toda a configuração do aparelho. Digite a placa (${placa(v.placa)}) para confirmar:`);
              if (conf) acao(b, async () => { await api.post(caminho, { ajuste: 'fabrica', confirmacao: conf }); toast('Comando na fila.'); f = await api.get(caminho); desenhar(); });
            }); return b; })()))) : null,
      !plataforma && gt06 ? el('p', { class: 'aviso pequeno', style: 'margin:0' }, 'Intervalos, alarmes e instalação são ajustados pela equipe da plataforma. Peça ao suporte o que precisar.') : null,
      secao('Últimos comandos', tabela(['Quando', 'Comando', 'Situação', 'Resposta'], f.comandos.map((c) => el('tr', {},
        td(dataHora(c.criado_em)), td([c.rotulo ?? c.tipo, el('div', { class: 'pequeno mudo mono' }, c.texto ?? '')]),
        td(etiqueta(c.status, c.status === 'confirmado' ? 'ok' : c.status === 'falhou' || c.status === 'expirado' ? 'erro' : 'aviso')),
        td(c.resposta ? el('span', { class: 'pequeno mono resposta' }, c.resposta) : '—'))), 'Nenhum comando ainda.')));
  }
  desenhar();
  modal(`Equipamento · ${placa(f.veiculo.placa)}`, (fechar) => [corpo, el('div', { class: 'linha', style: 'justify-content:flex-end;margin-top:12px' },
    el('button', { class: 'btn primario', onclick: () => fechar() }, 'Fechar'))], { largo: true });
}

async function telaEquipamentos(ctx) {
  const corpo = el('div');
  limpar(ctx.conteudo, acoesTopo(el('p', { class: 'mudo', style: 'margin:0;max-width:720px' },
    'Saúde de cada rastreador: sinal, bateria e comunicação. A ficha mostra as consultas e as funções do J16.')), corpo);
  async function carregar() {
    const veiculos = (await api.get(`${base(ctx)}/mapa`)).filter((x) => x.imei);
    limpar(corpo, cartao(null, tabela(['Veículo', 'Rastreador', 'Sinal 4G', '>Bateria', 'Comunicação', 'Situação', '^'], veiculos.map((x) => el('tr', {},
      td([el('strong', {}, placa(x.placa)), x.descricao ? el('div', { class: 'pequeno mudo' }, x.descricao) : null]),
      td([x.rastreador_modelo ?? x.protocolo, el('div', { class: 'pequeno mudo mono' }, x.imei)]), td(barrasSinal(x.sinal_gsm)),
      td(x.tensao !== null && x.tensao !== undefined ? `${Number(x.tensao).toFixed(1).replace('.', ',')} V` : '—', 'dir num'), td(desde(x.comunicacao_em)),
      td(x.situacao === 'sem_sinal' ? etiqueta('sem sinal', 'erro') : etiqueta('comunicando', 'ok')),
      el('td', { class: 'acoes' }, x.protocolo !== 'api' ? botao('Ficha', '', () => abrirFicha(ctx, x.id)) : null))), 'Nenhum veículo com rastreador.')));
  }
  ctx.parar(repetir(carregar, 30_000));
}

export const TELAS_FROTA = { ranking: telaRanking, custos: telaCustos, equipamentos: telaEquipamentos };
