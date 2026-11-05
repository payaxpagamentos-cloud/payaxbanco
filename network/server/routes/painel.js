'use strict';

const { Router } = require('express');
const { agora } = require('../db');
const { pode } = require('../lib/permissoes');
const { situacaoPlano } = require('../lib/manutencao');
const { dataLocal } = require('../lib/datas');
const frota = require('../lib/frota');
const noc = require('../lib/noc');

/** Visão geral: cada indicador traz período, fonte e horário; seções aparecem conforme as permissões do perfil. */
module.exports = (db) => {
  const r = Router();

  r.get('/resumo', (req, res) => {
    const p = req.usuario.perfil;
    const org = req.org;
    const hoje = dataLocal(req.usuario.fuso);
    const t = agora();
    const out = { gerado_em: t, indicadores: {}, alertas: [], chamados: null, agenda_frota: null };

    if (pode(p, 'noc.ver')) {
      out.indicadores.disponibilidade = { ...noc.disponibilidadeMedida(db, org), fonte_descricao: 'Amostras de disponibilidade dos equipamentos ativos' };
      for (const i of db.prepare(`SELECT i.*, a.codigo AS ativo_codigo, u.nome AS responsavel_nome FROM incidentes i LEFT JOIN ativos_rede a ON a.id = i.ativo_id
        LEFT JOIN usuarios u ON u.id = i.responsavel_id WHERE i.organizacao_id = ? AND i.status <> 'resolvido' AND i.incidente_pai_id IS NULL
        ORDER BY CASE i.severidade WHEN 'critica' THEN 0 WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END, i.inicio LIMIT 6`).all(org)) {
        const imp = noc.impacto(db, i);
        const ev = i.evidencias ? JSON.parse(i.evidencias) : {};
        const m = ev.medicoes?.at(-1);
        out.alertas.push({ tipo: 'incidente', id: i.id, criticidade: i.severidade, titulo: i.titulo, em: i.inicio, responsavel: i.responsavel_nome,
          evidencia: m ? `${m.valor}${m.unidade ? ` ${m.unidade}` : ''} em ${m.em}` : i.origem === 'manual' ? 'Registro manual' : null,
          detalhe: imp.portas_ocupadas ? `${imp.portas_ocupadas} porta(s) ocupada(s) nas CTOs afetadas${imp.clientes_unicos ? ` · ${imp.clientes_unicos} cliente(s) único(s)` : ''}` : null,
          link: `#/noc/incidente/${i.id}` });
      }
    }

    if (pode(p, 'chamados.ver')) {
      const tec = p === 'tecnico' ? ' AND (c.tecnico_id = ? OR c.id IN (SELECT chamado_id FROM chamado_equipe WHERE tecnico_id = ?))' : '';
      const ps = p === 'tecnico' ? [req.usuario.tecnico_id ?? -1, req.usuario.tecnico_id ?? -1] : [];
      const ab = db.prepare(`SELECT COUNT(*) AS n, SUM(prioridade = 'critica') AS criticos, SUM(prazo IS NOT NULL AND prazo < ?) AS atrasados FROM chamados c
        WHERE organizacao_id = ? AND status NOT IN ('aprovado','cancelado')${tec}`).get(t, org, ...ps);
      out.indicadores.chamados = { abertos: ab.n, criticos: ab.criticos ?? 0, atrasados: ab.atrasados ?? 0, fonte: 'Chamados técnicos', em: t };
      out.chamados = db.prepare(`SELECT c.id, c.numero, c.titulo, c.bairro, c.prioridade, c.status, c.prazo, c.agendado_para, t.nome AS tecnico_nome FROM chamados c
        LEFT JOIN tecnicos t ON t.id = c.tecnico_id WHERE c.organizacao_id = ? AND c.status NOT IN ('aprovado','cancelado')${tec}
        ORDER BY CASE c.prioridade WHEN 'critica' THEN 0 WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END, COALESCE(c.prazo, c.agendado_para, c.criado_em) LIMIT 6`).all(org, ...ps);
    }

    if (pode(p, 'equipe.ver') || pode(p, 'chamados.atribuir')) {
      const x = db.prepare(`SELECT COUNT(*) AS ativos, SUM(EXISTS (SELECT 1 FROM chamados c WHERE c.tecnico_id = t.id AND c.status IN ('em_rota','em_execucao'))) AS em_campo
        FROM tecnicos t WHERE t.organizacao_id = ? AND t.status = 'ativo'`).get(org);
      out.indicadores.tecnicos = { em_campo: x.em_campo ?? 0, ativos: x.ativos, criterio: 'Com chamado em rota ou em execução', fonte: 'Chamados técnicos', em: t };
    }

    if (pode(p, 'manutencao.ver')) {
      const veiculos = db.prepare("SELECT * FROM veiculos WHERE organizacao_id = ? AND status_base <> 'inativo'").all(org);
      const st = veiculos.map((v) => frota.disponibilidade(db, v));
      out.indicadores.frota = { total: veiculos.length, disponiveis: st.filter((s) => s.disponivel).length, em_oficina: st.filter((s) => s.status === 'em_oficina').length,
        fonte: 'Cadastro e restrições da frota', em: t };
      for (const pl of db.prepare(`SELECT p.*, v.placa, v.odometro_km FROM planos_preventivos p JOIN veiculos v ON v.id = p.veiculo_id WHERE p.organizacao_id = ? AND p.ativo = 1
        AND v.status_base <> 'inativo'`).all(org)) {
        const s = situacaoPlano(pl, pl, hoje);
        if (['vencido', 'critico'].includes(s.situacao)) {
          out.alertas.push({ tipo: 'manutencao', id: pl.id, criticidade: s.situacao === 'critico' ? 'alta' : 'media', titulo: `${pl.item} vencido · ${pl.placa}`, em: null,
            evidencia: s.motivos.join(' '), detalhe: s.limitacao, link: '#/manutencao' });
        }
      }
      for (const rs of db.prepare(`SELECT r.*, v.placa FROM veiculo_restricoes r JOIN veiculos v ON v.id = r.veiculo_id WHERE r.organizacao_id = ? AND r.fim IS NULL ORDER BY r.inicio LIMIT 5`).all(org)) {
        out.alertas.push({ tipo: 'veiculo', id: rs.veiculo_id, criticidade: 'baixa', titulo: `${rs.placa} indisponível`, em: rs.inicio, evidencia: rs.motivo, detalhe: 'Fora da escala até a liberação', link: `#/veiculos/${rs.veiculo_id}` });
      }
      out.agenda_frota = db.prepare(`SELECT m.id, m.tipo, m.descricao, m.status, m.data_planejada, m.km_planejado, m.indisponivel_inicio, m.indisponivel_fim, v.placa, f.nome AS fornecedor_nome
        FROM manutencoes m JOIN veiculos v ON v.id = m.veiculo_id LEFT JOIN fornecedores f ON f.id = m.fornecedor_id WHERE m.organizacao_id = ? AND m.status NOT IN ('concluido','cancelado')
        ORDER BY COALESCE(m.data_planejada, '9999'), m.id LIMIT 6`).all(org);
    }
    if (pode(p, 'frota.documentos')) {
      const limite = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
      for (const d of db.prepare('SELECT d.*, v.placa FROM veiculo_documentos d JOIN veiculos v ON v.id = d.veiculo_id WHERE d.organizacao_id = ? AND d.vencimento <= ? ORDER BY d.vencimento LIMIT 5').all(org, limite)) {
        out.alertas.push({ tipo: 'documento', id: d.veiculo_id, criticidade: d.vencimento < hoje ? 'alta' : 'baixa', titulo: `${d.tipo.toUpperCase()} ${d.vencimento < hoje ? 'vencido' : 'vencendo'} · ${d.placa}`,
          em: null, evidencia: `Vencimento ${d.vencimento}`, link: `#/veiculos/${d.veiculo_id}` });
      }
    }
    const ordem = { critica: 0, alta: 1, media: 2, baixa: 3 };
    out.alertas.sort((a, b) => ordem[a.criticidade] - ordem[b.criticidade]);
    res.json(out);
  });

  return r;
};
