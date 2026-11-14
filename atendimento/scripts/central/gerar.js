'use strict';
/**
 * Monta a configuração do Asterisk a partir do que está cadastrado na ZOE (GET /api/central/config de
 * cada empresa): ramais (pjsip), filas (queues) e o plano de discagem (extensions). Função pura: recebe
 * as configurações e devolve o texto dos arquivos — quem escreve e recarrega é a ponte (zoe-central).
 *
 * O plano de discagem avisa a ZOE de cada ligação por UserEvent (início, atendida, fim); a ponte
 * escuta pelo AMI e manda para a API. O limite de chamadas simultâneas é conferido aqui mesmo
 * (GROUP_COUNT), antes de a ligação acontecer.
 *
 * Nomes no Asterisk:
 *   ramal 1001 da empresa 3 → endpoint 3_1001 (aparelho SIP) e 3_1001w (telefone no navegador)
 *   fila 5 da empresa 3     → queue zoe-e3-f5
 *   destinos da empresa 3   → contexto zoe-e3-destinos: ramal-<id>, fila-<id>, ura-<id>, zoe, padrao, fim
 */

const ESTRATEGIA = { todos: 'ringall', sequencial: 'linear', aleatorio: 'random', menos_chamadas: 'fewestcalls' };

/** Só o que é seguro numa linha de configuração (sem quebra, sem ; que vira comentário, sem aspas). */
const linha = (t) => String(t ?? '').replace(/[\r\n;"\\[\]]/g, ' ').trim();
const digitos = (t) => String(t ?? '').replace(/\D/g, '');
const nomeVisivel = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9 .-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Ramal';

/** Formas em que a operadora pode entregar o número discado (DID): 1130001000, 551130001000, +55…, 0…. */
const formasDoNumero = (n) => [...new Set([n, `55${n}`, `+55${n}`, `0${n}`])];

function gerar(empresas, opcoes = {}) {
  const o = {
    agi: '/usr/local/bin/zoe-agi',
    gravacoes: '/var/spool/asterisk/monitor/zoe',
    toque: 30,
    webrtc: false,
    troncos: {}, // { [id]: { usuario, senha, registro } } — a credencial da operadora fica só aqui
    ipPublico: '',
    ...opcoes,
  };
  const pjsip = [];
  const filasConf = [];
  const plano = [];
  const cab = '; Gerado pela ZOE (zoe-central). NÃO edite: este arquivo é refeito a cada mudança no painel.\n';

  // ---------- Troncos (operadoras): um por rota de saída usada por alguma empresa ----------
  const troncos = new Map();
  for (const e of empresas) if (e.terminacao) troncos.set(e.terminacao.id, e.terminacao);
  for (const t of troncos.values()) {
    const nome = `zoe-tronco-${t.id}`;
    const cred = o.troncos[t.id] ?? {};
    const host = linha(t.host);
    const porta = Number(t.porta) || 5060;
    pjsip.push(`; ${linha(t.nome)}`,
      `[${nome}]`, 'type=endpoint', 'context=zoe-entrada', 'disallow=all', 'allow=alaw,ulaw', `aors=${nome}`,
      'direct_media=no', 'rtp_symmetric=yes', 'force_rport=yes', 'rewrite_contact=yes', 'trust_id_inbound=yes',
      ...(cred.usuario ? [`outbound_auth=${nome}-auth`, `from_user=${linha(cred.usuario)}`, `from_domain=${host}`] : []),
      '', `[${nome}]`, 'type=aor', `contact=sip:${host}:${porta}`, 'qualify_frequency=60', '',
      `[${nome}-ident]`, 'type=identify', `endpoint=${nome}`, `match=${host}`, '');
    if (cred.usuario) {
      pjsip.push(`[${nome}-auth]`, 'type=auth', 'auth_type=userpass', `username=${linha(cred.usuario)}`, `password=${linha(cred.senha)}`, '');
      if (cred.registro) {
        pjsip.push(`[${nome}-registro]`, 'type=registration', `outbound_auth=${nome}-auth`, `server_uri=sip:${host}:${porta}`,
          `client_uri=sip:${linha(cred.usuario)}@${host}:${porta}`, `contact_user=${linha(cred.usuario)}`, 'retry_interval=60', 'expiration=300', '');
      }
    }
  }

  // ---------- Entrada: o número discado vira a empresa e o destino dela ----------
  const entrada = ['[zoe-entrada]', '; Ligações da operadora. Número que não está na ZOE é recusado.'];
  const numerosDid = ['[zoe-did]'];

  // ---------- Sub-rotinas comuns ----------
  plano.push(
    '[zoe-inicio]',
    '; ARG1 direção, ARG2 origem, ARG3 destino, ARG4 limite de simultâneas, ARG5 gravar (1/0)',
    'exten => s,1,Set(__ZOE_EMPRESA=${ZOE_EMPRESA})',
    ' same => n,Set(GROUP(zoe)=e${ZOE_EMPRESA})',
    ' same => n,GotoIf($[${GROUP_COUNT(e${ZOE_EMPRESA}@zoe)} > ${ARG4}]?cheio)',
    ' same => n,Set(__ZOE_CHAMADA=${UNIQUEID})',
    ' same => n,Set(CHANNEL(hangup_handler_push)=zoe-fim,s,1)',
    ' same => n,UserEvent(ZoeInicio,empresa: ${ZOE_EMPRESA},uid: ${ZOE_CHAMADA},direcao: ${ARG1},origem: ${FILTER(0-9*#+,${ARG2})},destino: ${FILTER(0-9*#+,${ARG3})})',
    ' same => n,GotoIf($["${ARG5}" != "1"]?fim)',
    ` same => n,MixMonitor(${o.gravacoes}/\${ZOE_CHAMADA}.wav,b)`,
    ' same => n(fim),Return()',
    ' same => n(cheio),Playback(all-circuits-busy-now)',
    ' same => n,Hangup(34)',
    '',
    '[zoe-fim]',
    '; Roda ao desligar (hangup handler): a ponte fecha a chamada na ZOE com o resultado.',
    'exten => s,1,UserEvent(ZoeFim,empresa: ${ZOE_EMPRESA},uid: ${ZOE_CHAMADA},dialstatus: ${DIALSTATUS},queuestatus: ${QUEUESTATUS},zoe: ${ZOE_STATUS},causa: ${HANGUPCAUSE})',
    ' same => n,Return()',
    '',
    '[zoe-atendeu]',
    '; Roda no canal de quem atendeu (ramal ou operadora). Se a ligação passou pela ZOE, abre a passagem no painel.',
    'exten => s,1,UserEvent(ZoeAtendida,empresa: ${ZOE_EMPRESA},uid: ${ZOE_CHAMADA},canal: ${CHANNEL(name)})',
    ' same => n,GotoIf($["${ZOE_UID}" = ""]?fim)',
    ` same => n,AGI(${o.agi},atendeu)`,
    ' same => n(fim),Return()',
    '');

  for (const e of empresas) {
    const eid = Number(e.empresa.id);
    const limite = Math.max(0, Number(e.empresa.limite_canais) || 0);
    const gravarEmpresa = e.empresa.gravar_chamadas ? 1 : 0;
    const ctx = `zoe-e${eid}`;
    const ramais = e.ramais ?? [];
    const ramalPorId = new Map(ramais.map((r) => [r.id, r]));
    const primeiraFila = (e.filas ?? [])[0];
    const destinoLabel = (tipo, id) => {
      if (tipo === 'zoe') return 'zoe';
      if (tipo === 'ramal' && ramalPorId.has(id)) return `ramal-${id}`;
      if (tipo === 'fila' && (e.filas ?? []).some((f) => f.id === id)) return `fila-${id}`;
      if (tipo === 'ura' && (e.uras ?? []).some((u) => u.id === id)) return `ura-${id}`;
      return 'fim';
    };
    const dialRamal = (r) => [`PJSIP/${eid}_${digitos(r.numero)}`, ...(o.webrtc ? [`PJSIP/${eid}_${digitos(r.numero)}w`] : [])].join('&');

    // Ramais (aparelho SIP e, com WebRTC, o telefone do navegador).
    pjsip.push(`; ===== ${linha(e.empresa.nome)} (empresa ${eid}) =====`);
    for (const r of ramais) {
      const num = digitos(r.numero);
      const comuns = [
        `context=${ctx}-ramais`, `callerid="${nomeVisivel(r.nome)}" <${num}>`,
        `set_var=__ZOE_EMPRESA=${eid}`, `set_var=ZOE_RAMAL=${num}`, `set_var=ZOE_GRAVAR=${gravarEmpresa && r.gravar ? 1 : 0}`,
        'direct_media=no', 'rtp_symmetric=yes', 'force_rport=yes', 'rewrite_contact=yes',
        ...(o.ipPublico ? [`external_media_address=${o.ipPublico}`, `external_signaling_address=${o.ipPublico}`] : []),
      ];
      const fichas = [[`${eid}_${num}`, ['disallow=all', 'allow=ulaw,alaw,g722'], 2]];
      if (o.webrtc) fichas.push([`${eid}_${num}w`, ['webrtc=yes', 'disallow=all', 'allow=opus,ulaw,alaw'], 5]);
      for (const [nome, midia, contatos] of fichas) {
        pjsip.push(`[${nome}]`, 'type=endpoint', ...midia, `auth=${nome}`, `aors=${nome}`, ...comuns, '',
          `[${nome}]`, 'type=auth', 'auth_type=userpass', `username=${nome}`, `password=${linha(r.senha_sip)}`, '',
          `[${nome}]`, 'type=aor', `max_contacts=${contatos}`, 'remove_existing=yes', 'qualify_frequency=60', '');
      }
    }

    // Filas: as mesmas do WhatsApp, com os ramais escolhidos em Telefonia › Filas.
    for (const f of e.filas ?? []) {
      filasConf.push(`; ${linha(e.empresa.nome)} › ${linha(f.nome)}`, `[${ctx}-f${f.id}]`, `strategy=${ESTRATEGIA[f.estrategia] ?? 'ringall'}`,
        'timeout=20', 'retry=2', 'wrapuptime=5', 'joinempty=yes', 'leavewhenempty=no', 'ringinuse=no', 'announce-holdtime=no');
      for (const numero of f.ramais ?? []) {
        const r = ramais.find((x) => x.numero === numero);
        if (!r) continue;
        const num = digitos(numero);
        filasConf.push(`member => PJSIP/${eid}_${num},0,${nomeVisivel(r.nome)},PJSIP/${eid}_${num}`);
        if (o.webrtc) filasConf.push(`member => PJSIP/${eid}_${num}w,0,${nomeVisivel(r.nome)} (navegador),PJSIP/${eid}_${num}w`);
      }
      filasConf.push('');
    }

    // Números da empresa: cada forma do número leva ao mesmo destino.
    for (const n of e.numeros ?? []) {
      const did = digitos(n.numero);
      if (!did) continue;
      for (const forma of formasDoNumero(did)) entrada.push(`exten => ${forma},1,Goto(zoe-did,${did},1)`);
      numerosDid.push(
        `exten => ${did},1,Set(ZOE_EMPRESA=${eid})`,
        // O número de quem liga passa filtrado: vírgula ou parêntese nele quebraria os argumentos.
        ` same => n,Gosub(zoe-inicio,s,1(entrada,\${FILTER(0-9+,\${CALLERID(num)})},${did},${limite},${gravarEmpresa}))`,
        ` same => n,Goto(${ctx}-destinos,${n.destino_tipo ? destinoLabel(n.destino_tipo, n.destino_id) : 'fim'},1)`);
    }

    // De um ramal: outro ramal (interna) ou um número de fora (saída pela operadora da empresa).
    plano.push(`; ===== ${linha(e.empresa.nome)} (empresa ${eid}) =====`, `[${ctx}-ramais]`);
    for (const r of ramais) {
      const num = digitos(r.numero);
      plano.push(`exten => ${num},1,Gosub(zoe-inicio,s,1(interna,\${ZOE_RAMAL},${num},${limite},\${ZOE_GRAVAR}))`,
        ` same => n,Goto(${ctx}-destinos,ramal-${r.id},1)`);
    }
    const t = e.terminacao;
    const callerSaida = digitos((e.numeros ?? [])[0]?.numero);
    // _1XX: emergência e serviços (190, 192, 193…); _XXXXXXX.: 8 dígitos ou mais (fixo local, celular, DDD, 0800).
    for (const padrao of ['_1XX', '_XXXXXXX.']) {
      if (!t) { plano.push(`exten => ${padrao},1,Hangup(1)`); continue; }
      plano.push(`exten => ${padrao},1,Gosub(zoe-inicio,s,1(saida,\${ZOE_RAMAL},\${EXTEN},${limite},\${ZOE_GRAVAR}))`,
        ...(callerSaida ? [` same => n,Set(CALLERID(num)=${callerSaida})`] : []),
        ` same => n,Dial(PJSIP/${digitos(t.prefixo)}\${EXTEN}@zoe-tronco-${t.id},60,U(zoe-atendeu))`,
        ' same => n,Hangup()');
    }
    plano.push('');

    // Destinos: o que cada número, opção de URA ou transferência da ZOE pode alcançar.
    plano.push(`[${ctx}-destinos]`);
    for (const r of ramais) {
      plano.push(`exten => ramal-${r.id},1,Dial(${dialRamal(r)},${o.toque},U(zoe-atendeu))`, ' same => n,Hangup()');
    }
    for (const f of e.filas ?? []) {
      const espera = Math.max(10, Number(f.espera_maxima_s) || 120);
      plano.push(`exten => fila-${f.id},1,Queue(${ctx}-f${f.id},t,,,${espera},,,zoe-atendeu)`, ' same => n,Hangup()');
    }
    for (const u of e.uras ?? []) {
      plano.push(`exten => ura-${u.id},1,Answer()`, ` same => n,AGI(${o.agi},ura,${u.id})`,
        ` same => n,GotoIf($[\${DIALPLAN_EXISTS(${ctx}-destinos,\${ZOE_DESTINO},1)}]?\${ZOE_DESTINO},1)`,
        ' same => n,Goto(padrao,1)');
    }
    plano.push('exten => zoe,1,Answer()', ` same => n,AGI(${o.agi})`,
      ' same => n,GotoIf($["${ZOE_STATUS}" = "resolvido" | "${ZOE_STATUS}" = "desligou"]?fim,1)',
      ` same => n,GotoIf($["\${ZOE_FILA_ID}" != "" & \${DIALPLAN_EXISTS(${ctx}-destinos,fila-\${ZOE_FILA_ID},1)}]?fila-\${ZOE_FILA_ID},1)`,
      ' same => n,Goto(padrao,1)',
      primeiraFila ? `exten => padrao,1,Goto(fila-${primeiraFila.id},1)` : 'exten => padrao,1,Hangup()',
      'exten => fim,1,Hangup()',
      '');
  }

  entrada.push('exten => _X.,1,Hangup(1)', 'exten => _+X.,1,Hangup(1)', '');
  numerosDid.push('');
  return {
    'pjsip_zoe.conf': cab + pjsip.join('\n') + '\n',
    'queues_zoe.conf': cab + filasConf.join('\n') + '\n',
    'extensions_zoe.conf': cab + [...plano, ...entrada, ...numerosDid].join('\n') + '\n',
  };
}

/** "PJSIP/3_1001w-0000002a" → { empresa: 3, ramal: '1001', web: true } (ou null para tronco/outros). */
function ramalDoCanal(canal) {
  const m = String(canal ?? '').match(/^PJSIP\/(\d+)_(\d+)(w?)-/);
  return m ? { empresa: Number(m[1]), ramal: m[2], web: m[3] === 'w' } : null;
}

/** AOR "3_1001w" → { empresa: 3, ramal: '1001', web: true }. */
function ramalDoAor(aor) {
  const m = String(aor ?? '').match(/^(\d+)_(\d+)(w?)$/);
  return m ? { empresa: Number(m[1]), ramal: m[2], web: m[3] === 'w' } : null;
}

module.exports = { gerar, ramalDoCanal, ramalDoAor, formasDoNumero, ESTRATEGIA };
