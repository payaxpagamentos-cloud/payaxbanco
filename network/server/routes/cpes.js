'use strict';

const { Router } = require('express');
const { agora } = require('../db');
const { exigir } = require('../auth');
const { ErroNegocio } = require('../lib/erros');
const { registrar } = require('../lib/auditoria');
const { listaPaginada, like } = require('../lib/http');
const { cifrar } = require('../lib/cripto');
const acs = require('../lib/acs');
const v = require('../lib/validacao');

/*
 * Aparelho do assinante (CPE/ONT) pelo TR-069.
 *
 * Nenhuma rota aqui "configura o Wi-Fi" de forma síncrona, porque o protocolo não permite: quem liga é o
 * aparelho. O que estas rotas fazem é guardar o pedido e bater na porta do CPE para ele ligar agora. A
 * resposta diz qual dos dois caminhos aconteceu — "o aparelho atendeu e está aplicando" ou "o pedido ficou
 * guardado para o próximo contato dele" — e a tela repete isso em vez de dizer que já está feito.
 */
module.exports = (db) => {
  const r = Router();

  const buscar = (req, id) => {
    const x = db.prepare('SELECT * FROM cpes WHERE id = ? AND organizacao_id = ?').get(Number(id), req.org);
    if (!x) throw new ErroNegocio('Aparelho não encontrado.', 404);
    return x;
  };
  const comTarefas = (cpe) => ({
    ...acs.publico(cpe),
    servico: cpe.servico_id ? db.prepare(`SELECT s.id, s.login, c.numero AS contrato_numero, a.nome AS assinante_nome, a.id AS assinante_id
      FROM servicos s JOIN contratos c ON c.id = s.contrato_id JOIN assinantes a ON a.id = c.assinante_id WHERE s.id = ?`).get(cpe.servico_id) : null,
    tarefas: db.prepare(`SELECT t.*, u.nome AS usuario_nome FROM cpe_tarefas t LEFT JOIN usuarios u ON u.id = t.usuario_id
      WHERE t.cpe_id = ? ORDER BY t.id DESC LIMIT 25`).all(cpe.id)
      .map((t) => ({ ...t, parametros: undefined, resultado: t.resultado ? JSON.parse(t.resultado) : null })),
  });

  /** Guarda o pedido e tenta fazer o aparelho ligar agora. */
  async function pedir(req, cpe, { rpc, parametros, descricao }) {
    const tarefa = acs.enfileirar(db, { org: req.org, cpeId: cpe.id, rpc, parametros, descricao, origem: 'usuario', usuarioId: req.usuario.id });
    const chamada = await acs.chamar(db, cpe);
    return {
      tarefa: { ...tarefa, parametros: undefined },
      chamada,
      aviso: chamada.atendeu
        ? 'O aparelho atendeu a chamada e está aplicando. A confirmação aparece aqui em instantes.'
        : `${chamada.motivo} Nada foi aplicado ainda.`,
    };
  }

  // ---------------- Configuração do ACS ----------------
  // Declarada antes de /:id para "acs" não ser lido como identificador.
  r.get('/acs', exigir('integracoes.ver'), (req, res) => {
    const o = db.prepare('SELECT acs_usuario, acs_url, acs_senha_cifrada FROM organizacoes WHERE id = ?').get(req.org);
    const base = `${req.protocol}://${req.get('host')}${req.baseUrl.replace(/\/cpes$/, '')}/acs`;
    res.json({
      usuario: o.acs_usuario,
      url: o.acs_url,
      senha_configurada: Boolean(o.acs_senha_cifrada),
      // Endereço que o CPE precisa ter configurado para ligar para cá.
      url_sugerida: base,
      aparelhos: db.prepare('SELECT COUNT(*) AS n FROM cpes WHERE organizacao_id = ?').get(req.org).n,
      // Quantos falaram nas últimas 24 h: é o número que diz se o ACS está mesmo recebendo.
      ativos_24h: db.prepare('SELECT COUNT(*) AS n FROM cpes WHERE organizacao_id = ? AND ultimo_contato >= ?')
        .get(req.org, new Date(Date.now() - 86400_000).toISOString()).n,
    });
  });

  r.put('/acs', exigir('integracoes.editar'), (req, res) => {
    const b = req.body ?? {};
    const usuario = v.texto(b.usuario, 'o usuário do ACS', 60);
    v.exigir(/^[A-Za-z0-9._-]{3,60}$/.test(usuario), 'Usuário do ACS inválido (letras, números, ponto, traço ou sublinhado).');
    const atual = db.prepare('SELECT acs_senha_cifrada FROM organizacoes WHERE id = ?').get(req.org);
    const senha = b.senha ? String(b.senha) : null;
    if (senha) v.exigir(senha.length >= 12, 'A senha do ACS deve ter pelo menos 12 caracteres: ela fica guardada em milhares de aparelhos.');
    if (!senha && !atual.acs_senha_cifrada) throw new ErroNegocio('Informe a senha que os aparelhos vão usar para falar com o ACS.', 422);
    const url = v.opcional(b.url, 'o endereço do ACS', 300);
    db.prepare('UPDATE organizacoes SET acs_usuario = ?, acs_url = ?, acs_senha_cifrada = COALESCE(?, acs_senha_cifrada) WHERE id = ?')
      .run(usuario, url, senha ? cifrar(senha) : null, req.org);
    registrar(db, req, 'acs_configurado', { recurso: 'organizacao', recursoId: req.org, depois: { usuario, url, senha_trocada: Boolean(senha) } });
    res.json({ usuario, url, senha_configurada: true,
      aviso: senha ? 'Senha trocada: os aparelhos já provisionados com a senha anterior param de falar com o ACS até serem atualizados.' : null });
  });

  // ---------------- Aparelhos ----------------
  r.get('/', exigir('contratos.ver'), (req, res) => {
    const f = ['c.organizacao_id = ?'];
    const p = [req.org];
    if (req.query.busca) { f.push("(c.serial LIKE ? ESCAPE '\\' OR c.modelo LIKE ? ESCAPE '\\' OR a.nome LIKE ? ESCAPE '\\')"); p.push(like(req.query.busca), like(req.query.busca), like(req.query.busca)); }
    if (req.query.sem_vinculo === '1') f.push('c.servico_id IS NULL');
    const lista = listaPaginada(db, `SELECT c.*, s.login, ct.numero AS contrato_numero, a.nome AS assinante_nome, a.id AS assinante_id
      FROM cpes c LEFT JOIN servicos s ON s.id = c.servico_id LEFT JOIN contratos ct ON ct.id = s.contrato_id LEFT JOIN assinantes a ON a.id = ct.assinante_id
      WHERE ${f.join(' AND ')} ORDER BY c.ultimo_contato DESC`, p, req.query);
    lista.itens = lista.itens.map(acs.publico);
    res.json(lista);
  });

  r.get('/:id', exigir('contratos.ver'), (req, res) => res.json(comTarefas(buscar(req, req.params.id))));

  /** Configura o Wi-Fi do assinante. O que não for informado não é tocado no aparelho. */
  r.post('/:id/wifi', exigir('contratos.editar'), async (req, res, next) => {
    try {
      const cpe = buscar(req, req.params.id);
      const b = req.body ?? {};
      const ssid = v.opcional(b.ssid, 'o nome da rede', 32);
      const senha = b.senha ? String(b.senha) : null;
      const canal = b.canal === undefined || b.canal === '' ? null : v.inteiro(b.canal, 'o canal', { min: 0, max: 196 });
      if (ssid) v.exigir(/^[\x20-\x7E]{1,32}$/.test(ssid), 'O nome da rede aceita de 1 a 32 caracteres comuns (sem acentos, para o aparelho não recusar).');
      if (senha) v.exigir(senha.length >= 8 && senha.length <= 63, 'A senha do Wi-Fi tem de 8 a 63 caracteres (regra do WPA2).');
      v.exigir(ssid || senha || canal !== null, 'Informe pelo menos o nome da rede, a senha ou o canal.');

      const pares = acs.parametrosWifi(cpe, { ssid, senha, canal });
      const descricao = [ssid ? `rede "${ssid}"` : null, senha ? 'senha nova' : null, canal !== null ? `canal ${canal}` : null].filter(Boolean).join(', ');
      const r2 = await pedir(req, cpe, { rpc: 'SetParameterValues', parametros: { pares }, descricao: `Wi-Fi: ${descricao}` });
      // Depois de escrever, ler de volta: o que vale na tela é o que o aparelho confirma.
      acs.enfileirar(db, { org: req.org, cpeId: cpe.id, rpc: 'GetParameterValues', descricao: 'Conferência depois da alteração', origem: 'sistema' });
      // O desejado fica no serviço do contrato; a senha, cifrada.
      if (cpe.servico_id) {
        db.prepare(`UPDATE servicos SET wifi_ssid = COALESCE(?, wifi_ssid), wifi_canal = COALESCE(?, wifi_canal),
          wifi_senha_cifrada = COALESCE(?, wifi_senha_cifrada), versao = versao + 1 WHERE id = ?`)
          .run(ssid, canal === null ? null : String(canal), senha ? cifrar(senha) : null, cpe.servico_id);
      }
      // A senha do Wi-Fi não entra na auditoria: só o fato de ter sido trocada.
      registrar(db, req, 'cpe_wifi_configurado', { recurso: 'cpe', recursoId: cpe.id, depois: { ssid, canal, senha_trocada: Boolean(senha), atendeu: r2.chamada.atendeu } });
      res.status(201).json({ ...r2, cpe: comTarefas(db.prepare('SELECT * FROM cpes WHERE id = ?').get(cpe.id)) });
    } catch (err) { next(err); }
  });

  r.post('/:id/ler', exigir('contratos.ver'), async (req, res, next) => {
    try {
      const cpe = buscar(req, req.params.id);
      const r2 = await pedir(req, cpe, { rpc: 'GetParameterValues', descricao: 'Leitura do aparelho' });
      res.status(201).json({ ...r2, cpe: comTarefas(db.prepare('SELECT * FROM cpes WHERE id = ?').get(cpe.id)) });
    } catch (err) { next(err); }
  });

  r.post('/:id/reiniciar', exigir('contratos.editar'), async (req, res, next) => {
    try {
      const cpe = buscar(req, req.params.id);
      const r2 = await pedir(req, cpe, { rpc: 'Reboot', descricao: 'Reinício pedido pelo atendimento' });
      registrar(db, req, 'cpe_reiniciado', { recurso: 'cpe', recursoId: cpe.id, depois: { atendeu: r2.chamada.atendeu } });
      res.status(201).json({ ...r2, aviso: r2.chamada.atendeu ? 'O aparelho atendeu e vai reiniciar: o assinante fica sem conexão por cerca de um minuto.' : r2.aviso });
    } catch (err) { next(err); }
  });

  /** Liga o aparelho ao serviço de um contrato (ou desfaz o vínculo). */
  r.post('/:id/vincular', exigir('contratos.editar'), (req, res) => {
    const cpe = buscar(req, req.params.id);
    const servicoId = req.body?.servico_id ? v.inteiro(req.body.servico_id, 'o serviço', { min: 1 }) : null;
    if (servicoId) {
      const s = db.prepare('SELECT * FROM servicos WHERE id = ? AND organizacao_id = ?').get(servicoId, req.org);
      if (!s) throw new ErroNegocio('Serviço não encontrado.', 404);
      const outro = db.prepare('SELECT serial FROM cpes WHERE servico_id = ? AND id <> ?').get(servicoId, cpe.id);
      if (outro) throw new ErroNegocio(`O serviço já está com o aparelho ${outro.serial}. Desfaça o vínculo dele antes.`, 409);
      db.prepare('UPDATE servicos SET cpe_serial = ?, cpe_modelo = ?, versao = versao + 1 WHERE id = ?').run(cpe.serial, cpe.modelo, servicoId);
    }
    db.prepare('UPDATE cpes SET servico_id = ? WHERE id = ?').run(servicoId, cpe.id);
    registrar(db, req, servicoId ? 'cpe_vinculado' : 'cpe_desvinculado', { recurso: 'cpe', recursoId: cpe.id, antes: { servico_id: cpe.servico_id }, depois: { servico_id: servicoId } });
    res.json(comTarefas(db.prepare('SELECT * FROM cpes WHERE id = ?').get(cpe.id)));
  });

  r.post('/tarefas/:id/cancelar', exigir('contratos.editar'), (req, res) => {
    const t = db.prepare("SELECT * FROM cpe_tarefas WHERE id = ? AND organizacao_id = ? AND situacao IN ('pendente','entregue')").get(Number(req.params.id), req.org);
    if (!t) throw new ErroNegocio('Tarefa não encontrada ou já concluída.', 404);
    db.prepare("UPDATE cpe_tarefas SET situacao = 'cancelada', concluido_em = ? WHERE id = ?").run(agora(), t.id);
    registrar(db, req, 'cpe_tarefa_cancelada', { recurso: 'cpe', recursoId: t.cpe_id, antes: { rpc: t.rpc, situacao: t.situacao } });
    res.json({ ...db.prepare('SELECT * FROM cpe_tarefas WHERE id = ?').get(t.id), parametros: undefined });
  });

  return r;
};
