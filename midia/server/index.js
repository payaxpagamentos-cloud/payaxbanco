'use strict';

const config = require('./config');
const { abrir } = require('./db');
const { criarApp } = require('./app');
const { manutencao } = require('./lib/monitor');
const { faturarAutomatico } = require('./lib/faturamento');
const backup = require('./lib/backup');
const avisos = require('./lib/avisos');
const contratos = require('./lib/contratos');
const clima = require('./lib/clima');
const smtpServidor = require('./lib/smtp-servidor');

const db = abrir();
// MIDIA_HOST=127.0.0.1 faz o sistema atender só o nginx da própria máquina (o certo no servidor).
criarApp(db).listen(config.port, process.env.MIDIA_HOST || undefined, () => {
  console.log(`[Vai Mídia] Painel: http://localhost:${config.port}${config.basePath}/`);
  console.log(`[Vai Mídia] Player da TV: http://localhost:${config.port}${config.basePath}/tv/`);
});

// Servidor de e-mail da plataforma: só sobe com MIDIA_EMAIL_DOMINIOS configurado. O que chega cai na
// caixa de entrada do CRM, ligado ao lead de quem escreveu.
smtpServidor.iniciar(db, {
  aoReceber: (e) => console.log(`[Vai Mídia] E-mail recebido de ${e.de}: ${e.assunto}`),
});

// Marca as TVs que pararam de falar com o servidor, encerra campanhas vencidas e expira códigos de pareamento.
setInterval(() => {
  try {
    const m = manutencao(db);
    if (m.offline.length) console.log(`[Vai Mídia] TVs offline: ${m.offline.map((t) => t.nome).join(', ')}`);
    if (m.encerradas) console.log(`[Vai Mídia] Campanhas encerradas por fim de período: ${m.encerradas}`);
  } catch (err) {
    console.error('[Vai Mídia] Falha na manutenção:', err.message);
  }
}, 60_000).unref();

// Backup do banco (padrão: a cada 24 h, guardando as 30 mais recentes) e espelho das mídias, quando configurado.
const fazerBackup = () => {
  try {
    const b = backup.gerar(db);
    const espelho = backup.espelhar();
    console.log(`[Vai Mídia] Backup gerado: ${b.nome} (${Math.round(b.tamanho / 1024)} kB)`
      + (espelho.ligado ? `; arquivos espelhados: ${espelho.copiados}` : ''));
  } catch (err) {
    console.error('[Vai Mídia] Falha no backup:', err.message);
  }
};
setInterval(fazerBackup, config.backupIntervaloHoras * 3_600_000).unref();
if (!backup.listar().length) setTimeout(fazerBackup, 30_000).unref();

// Faturas do mês fechado: gera na virada (quem fatura confere e marca como paga no painel).
const faturar = () => {
  try {
    const r = faturarAutomatico(db);
    if (r.geradas) console.log(`[Vai Mídia] Faturas geradas (${r.competencia}): ${r.geradas}; repasses: ${r.repasses}`);
  } catch (err) {
    console.error('[Vai Mídia] Falha ao gerar faturas:', err.message);
  }
};
setInterval(faturar, 6 * 3_600_000).unref();
setTimeout(faturar, 120_000).unref();

// Contratos: renova os de renovação automática e aplica o reajuste de percentual fixo na data combinada.
const cuidarDosContratos = () => {
  try {
    const r = contratos.rodarAutomatico(db);
    for (const x of r.renovados) console.log(`[Vai Mídia] Contrato ${x.numero} renovado até ${x.ate} (${x.campanhas} campanha(s) estendidas)`);
    for (const x of r.reajustados) console.log(`[Vai Mídia] Contrato ${x.numero} reajustado em ${(x.percentual / 100).toFixed(2)}% (${x.campanhas} campanha(s))`);
  } catch (err) {
    console.error('[Vai Mídia] Falha ao cuidar dos contratos:', err.message);
  }
};
setInterval(cuidarDosContratos, 12 * 3_600_000).unref();
setTimeout(cuidarDosContratos, 150_000).unref();

// Clima do dia nas telas (quando ligado nas configurações): uma consulta por cidade, de meia em meia hora.
const buscarClima = () => clima.atualizar(db)
  .then((r) => { if (r.ligado && r.atualizadas) console.log(`[Vai Mídia] Clima atualizado em ${r.atualizadas} de ${r.cidades} cidade(s)`); })
  .catch((err) => console.error('[Vai Mídia] Falha ao buscar o clima:', err.message));
setInterval(buscarClima, 30 * 60_000).unref();
setTimeout(buscarClima, 45_000).unref();

// Avisos por e-mail: tela fora do ar, fatura vencida, fila de aprovação parada e contratos para cuidar.
const avisar = () => avisos.rodar(db)
  .then((r) => { if (r.enviados) console.log(`[Vai Mídia] Avisos enviados: ${r.enviados}`); })
  .catch((err) => console.error('[Vai Mídia] Falha nos avisos:', err.message));
setInterval(avisar, 3_600_000).unref();
setTimeout(avisar, 90_000).unref();
