# Changelog — Manager Network

## Etapa 0 · Base de tráfego e Anti-DDoS (2026-11)

- **Coletor de rede** (`npm run coletor-rede`): NetFlow v5, NetFlow v9, IPFIX e sFlow v5 por UDP, com amostragem (do pacote ou do cadastro),
  IPv4/IPv6, VLAN, PPPoE do BRAS e MPLS. Só aceita roteadores cadastrados.
- **Tráfego**: entrada e saída por grupo de IPs, somadas por minuto (8 dias) e por IP e hora (400 dias); IPs que mais recebem e enviam, CSV e ficha do IP.
- **Anti-DDoS**: detecção a cada 5 s (médias de 5, 10 e 60 s) por IP e por grupo, com confirmação e histerese; vetor do ataque (amplificação, SYN, ICMP…);
  ataques de fora para dentro e saindo da rede separados; linha do tempo, comentários e relatório em PDF.
- **Bloqueio por BGP**: FlowSpec, blackhole e limpeza em linha, automático ou com aprovação, sempre com lista "nunca bloquear", limite de ações
  simultâneas, retirada automática e auditoria. Anúncios lidos pelo ExaBGP (`scripts/exabgp-sincronizar.js`); o sistema não entra no roteador.
- **Assinantes**: sessões pela cópia do accounting RADIUS (conferida pelo segredo) ou pela API; histórico de quem usou cada IP (mínimo de 366 dias, Marco Civil).
- **Avisos "Manager Network Alertas"** por Telegram, WhatsApp (API oficial da Meta, com modelo aprovado) e webhook, com fila e novas tentativas;
  aviso de roteador que parou de enviar flows.
- Novas permissões: `trafego.ver`, `ddos.ver`, `ddos.operar`, `ddos.configurar`, `assinantes.ver`, `avisos.configurar`.
- Demonstração renomeada para **Conecta Fibra**, com tráfego, ataques e sessões fictícios; simulador de flows (`npm run simulador`).
- Migração 2 (`trafego_antiddos`). Tokens de coletor ganham escopos (`amostras`, `sessoes`, `bgp`); os existentes continuam com `amostras`.
