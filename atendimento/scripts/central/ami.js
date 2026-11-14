'use strict';
/**
 * Cliente mínimo do AMI (Asterisk Manager Interface): login, ações com resposta (ActionID) e eventos.
 * Reconecta sozinho. Sem dependências: roda no Node do servidor do Asterisk.
 */
const net = require('node:net');
const { EventEmitter } = require('node:events');

/** Um bloco "Chave: valor\r\n…" vira objeto (cada chave como veio e também em minúsculas). */
function lerBloco(texto) {
  const o = {};
  for (const l of texto.split(/\r?\n/)) {
    const i = l.indexOf(':');
    if (i <= 0) continue;
    const k = l.slice(0, i).trim();
    const v = l.slice(i + 1).trim();
    o[k] = v;
    o[k.toLowerCase()] = v;
  }
  return o;
}

const bloco = (campos) => `${Object.entries(campos).filter(([, v]) => v !== undefined && v !== null)
  .map(([k, v]) => `${k}: ${String(v).replace(/[\r\n]/g, ' ')}`).join('\r\n')}\r\n\r\n`;

class Ami extends EventEmitter {
  constructor({ host = '127.0.0.1', porta = 5038, usuario, senha, reconectarMs = 5000 } = {}) {
    super();
    Object.assign(this, { host, porta, usuario, senha, reconectarMs });
    this.conectado = false;
    this.parado = false;
    this.seq = 0;
    this.pendentes = new Map();
  }

  iniciar() {
    this.parado = false;
    this._conectar();
    return this;
  }

  parar() {
    this.parado = true;
    clearTimeout(this._timer);
    this.socket?.destroy();
  }

  _conectar() {
    if (this.parado) return;
    let buffer = '';
    const s = net.connect(this.porta, this.host);
    this.socket = s;
    s.setEncoding('utf8');
    s.on('data', (parte) => {
      buffer += parte;
      let m;
      while ((m = buffer.match(/\r?\n\r?\n/))) {
        const texto = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + m[0].length);
        this._mensagem(lerBloco(texto));
      }
    });
    s.on('connect', async () => {
      try {
        const r = await this.acao({ Action: 'Login', Username: this.usuario, Secret: this.senha, Events: 'on' });
        if (r.response !== 'Success') throw new Error(r.message || 'login recusado');
        this.conectado = true;
        this.emit('conectado');
      } catch (err) {
        this.emit('erro', new Error(`AMI: ${err.message}`));
        s.destroy();
      }
    });
    s.on('error', (err) => this.emit('erro', new Error(`AMI: ${err.message}`)));
    s.on('close', () => {
      const estava = this.conectado;
      this.conectado = false;
      for (const p of this.pendentes.values()) { clearTimeout(p.relogio); p.falha(new Error('AMI desconectado')); }
      this.pendentes.clear();
      if (estava) this.emit('desconectado');
      if (!this.parado) this._timer = setTimeout(() => this._conectar(), this.reconectarMs);
    });
  }

  _mensagem(msg) {
    const p = msg.actionid ? this.pendentes.get(msg.actionid) : null;
    if (!p) {
      if (msg.event !== undefined) this.emit('evento', msg);
      return;
    }
    if (msg.response !== undefined) {
      // Ações que devolvem lista (ex.: PJSIPShowContacts) mandam os itens como eventos até o "…Complete".
      if (String(msg.eventlist).toLowerCase() === 'start' && msg.response === 'Success') { p.resposta = msg; return; }
      return this._concluir(msg.actionid, msg);
    }
    if (/complete$/i.test(msg.event ?? '') || String(msg.eventlist).toLowerCase() === 'complete') return this._concluir(msg.actionid, p.resposta ?? { response: 'Success' });
    p.eventos.push(msg);
  }

  _concluir(id, resposta) {
    const p = this.pendentes.get(id);
    this.pendentes.delete(id);
    clearTimeout(p.relogio);
    p.ok({ ...resposta, eventos: p.eventos });
  }

  /** Manda uma ação e espera a resposta (com os eventos da lista, se houver). */
  acao(campos, { prazoMs = 10000 } = {}) {
    return new Promise((ok, falha) => {
      if (!this.socket || this.socket.destroyed) return falha(new Error('AMI desconectado'));
      const id = `zoe-${++this.seq}`;
      const p = { ok, falha, eventos: [], resposta: null };
      p.relogio = setTimeout(() => { this.pendentes.delete(id); falha(new Error(`AMI: sem resposta para ${campos.Action}`)); }, prazoMs);
      this.pendentes.set(id, p);
      this.socket.write(bloco({ ...campos, ActionID: id }));
    });
  }

  /** Comando de console (ex.: "dialplan reload"). */
  comando(texto) {
    return this.acao({ Action: 'Command', Command: texto });
  }
}

module.exports = { Ami, lerBloco, bloco };
