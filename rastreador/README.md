# Rastreador de Veículos

Plataforma de rastreamento veicular, publicada em `/rastreador`, com dois níveis de acesso: a **central de rastreamento** (master),
que cuida das empresas clientes e do estoque de equipamentos, e as **empresas** (frotas, locadoras ou pessoas físicas), que acompanham os
próprios veículos.

| Perfil | O que vê |
|---|---|
| **Master** | A plataforma inteira: empresas, rastreadores (estoque e instalados), mapa de todas as frotas, usuários, diagnóstico, configurações, integrações e atividades. Entra no painel de qualquer empresa pela lista de Empresas. |
| **Suporte** | Como o master, sem usuários, configurações e atividades; não exclui empresas nem rastreadores. |
| **Cliente** (administrador da empresa) | O painel da própria empresa: mapa ao vivo, histórico, alertas, veículos, motoristas, cercas, manutenção, relatórios, comandos (bloqueio), configurações e integrações. |
| **Operador** | O painel da empresa para monitorar: consulta tudo e trata os alertas, sem alterar cadastros nem enviar comandos. |

Sistema independente: servidor, banco de dados (SQLite), usuários e login próprios. Mapa do OpenStreetMap (Leaflet servido pelo próprio
sistema). Tema escuro por padrão, com o claro no botão do topo.

## Como os veículos chegam ao sistema

| Origem | Como liga | Comandos |
|---|---|---|
| **Rastreador GT06** e compatíveis (GT06N, J16, ST-901, Concox…) | TCP direto na porta `RASTREADOR_GT06_PORTA` (padrão 5023). Login pelo IMEI, posições (0x12/0x22), estado (0x13: ignição, corte, alarme) e alarmes (0x16/0x26: pânico, corte de energia, violação). | Bloquear, desbloquear, pedir posição, reiniciar ou texto livre, entregues na hora se o equipamento estiver conectado (senão, quando conectar). A resposta do equipamento confirma. |
| **Celular** com o app **Traccar Client** (Android/iPhone) e rastreadores com protocolo **OsmAnd** | HTTP em `/rastreador/api/osmand` (parâmetros `id, lat, lon, timestamp, speed, bearing…` ou o JSON do Traccar Client novo). | Não recebe. |
| **Outro sistema** (gateway de outro protocolo, Traccar, outra plataforma) | API de integração com a chave da empresa: `POST /api/integracao/posicoes`. | O sistema busca em `GET /api/integracao/comandos` e responde em `POST /api/integracao/comandos/:id`. |

Equipamento que envia sem estar cadastrado aparece em **Rastreadores → Equipamentos não cadastrados**, com o botão para cadastrar.

## Telas

### Empresa
- **Dashboard**: veículos em movimento, parados ligados, sem sinal, km rodados hoje, alertas pendentes, gráfico da frota agora, km por dia
  (14 dias), últimos alertas, mais rodados na semana, alertas por tipo, manutenções vencidas/próximas e CNH vencendo em 30 dias.
- **Mapa ao vivo**: lista com busca e filtro por situação ao lado do mapa (atualiza a cada 10 s); veículo girado pelo curso e colorido pela
  situação; painel do veículo com velocidade, ignição, comunicação, motorista e hodômetro, e os botões **Histórico, Compartilhar, Pedir posição,
  Bloquear/Desbloquear** (bloquear pede a placa digitada). As cercas aparecem no mapa.
- **Histórico**: trajeto de até 7 dias com início, fim, paradas numeradas e alertas no mapa; viagens (clique destaca o trecho) e paradas;
  **reprodução** do trajeto com velocidade de 1× a 64×.
- **Alertas**: pendentes, tratados ou todos, por tipo, veículo e período; tratar um ou todos (com observação); CSV.
- **Veículos**: placa (antiga ou Mercosul), tipo, marca/modelo, limite de velocidade, rastreador e motorista; ajuste do hodômetro; links
  de localização ativos; exclusão (com todo o histórico) ou desativação. **Cadastrar celular como rastreador** gera o identificador para o app.
- **Motoristas**: CPF, telefone (com link do WhatsApp) e CNH com validade.
- **Cercas**: círculo (centro e raio) ou polígono desenhados no mapa; alerta de entrada e/ou saída; para todos os veículos ou só os escolhidos.
- **Manutenção**: planos por km (pelo hodômetro do rastreador) e/ou por dias, com situação em dia/próxima/vencida; registro do que foi feito
  (data, km, custo) e histórico.
- **Relatórios**: resumo por veículo no período (distância, motor ligado, velocidade máxima, dias com uso, excessos, alertas), viagens de um
  veículo (até 31 dias), CSV e impressão.
- **Comandos**: o que foi enviado, a situação (aguardando envio, enviado, confirmado, falhou, expirado, cancelado) e a resposta do equipamento.
- **Configurações**: alerta de ignição, horário e dias de uso permitidos, tempo para o alerta de sem comunicação, contato, plano contratado e
  usuários da empresa (administrador e operador).
- **Integrações**: chaves de API e o guia de como ligar GT06, celular e outros sistemas.

### Master
- **Dashboard**: empresas, veículos online, rastreadores (instalados e em estoque), mensagens recebidas hoje e por dia, conexões GT06,
  faturamento mensal (veículos ativos × mensalidade) e equipamentos não cadastrados.
- **Mapa geral**: todos os veículos de todas as empresas.
- **Empresas**: tipo, limite de veículos, mensalidade por veículo, editar, bloquear (os usuários não entram e as posições deixam de ser gravadas),
  excluir (os rastreadores voltam ao estoque). Clicar abre o painel da empresa.
- **Rastreadores**: estoque e instalados (IMEI, modelo, protocolo, chip e operadora, empresa, veículo, última comunicação, conectado agora).
- **Permissões e usuários**, **Diagnóstico** (servidor GT06, recepção, veículos mudos, comandos parados, empresas no limite),
  **Configurações** (tempos, retenção e os textos dos comandos GT06 do seu fabricante), **Integrações** e **Atividades**.

## Alertas

| Alerta | Quando |
|---|---|
| Excesso de velocidade | Passou do limite do veículo (avisa de novo só depois de voltar abaixo dele). |
| Entrada / saída da cerca | Mudou de dentro para fora (ou o contrário) de uma cerca ativa. A primeira posição só registra onde o veículo está. |
| Ignição ligada / desligada | Se ligado em Configurações da empresa. |
| Uso fora do horário | Ligou (ou andou, sem sinal de ignição) fora do horário e dos dias permitidos; uma vez por vez que liga. |
| Pânico, bateria desconectada, bateria baixa, violação | Enviados pelo próprio rastreador (o mesmo alarme repetido em 2 min não duplica). |
| Sem comunicação | O veículo não comunicou no tempo configurado na empresa (uma vez até voltar a comunicar). |

## Cálculos

- **Hodômetro** e **km por dia**: soma das distâncias entre posições (com o veículo andando ou num deslocamento de mais de 50 m: a oscilação
  do GPS parado não conta). **Horímetro**: tempo entre posições com a ignição ligada (no máximo 10 min por intervalo).
- **Saltos do GPS**: posição que exigiria mais de 250 km/h (ajustável) desde a anterior é descartada.
- **Viagens**: começam quando o veículo anda (5 km/h ou mais) e terminam com a ignição desligada ou parado por 5 min (ajustável);
  viagens de menos de 100 m são ignoradas.
- **Situação no mapa**: sem sinal quando não comunica há mais de 10 min (ajustável); em movimento a partir de 3 km/h; parado ligado ou parado.
- Posições antigas reenviadas pela memória do equipamento entram no histórico, mas não mudam a posição atual nem geram alertas.

## Link de localização compartilhada

Pelo mapa ao vivo, **Compartilhar** gera um link (1 hora a 7 dias) com a posição do veículo atualizando sozinha, sem login e sem histórico,
para mandar a um cliente ou à família (com o botão do WhatsApp). Só o hash do código fica guardado; o link pode ser cancelado em Veículos.

## API de integração

Chave da empresa (Integrações → Nova chave) no cabeçalho `X-Api-Key`. Base: `https://SEU-DOMINIO/rastreador/api/integracao`.

| Método e caminho | Para quê |
|---|---|
| `GET /veiculos` | Frota com a última posição, situação, ignição, bloqueio, hodômetro e motorista. |
| `GET /veiculos/:placa/posicoes?de=&ate=` | Posições (ISO 8601, até 7 dias, até 20.000). |
| `GET /alertas?desde=` | Alertas desde a data (padrão: últimas 24 h). |
| `POST /posicoes` | Uma ou uma lista (até 500) de `{ imei, lat, lng, velocidade_kmh?, curso?, ignicao?, tensao?, evento?, gps_em? }`. Só rastreadores da empresa. |
| `GET /comandos` | Comandos pendentes dos rastreadores do tipo "API" (passam a "enviado"). |
| `POST /comandos/:id` | Resultado: `{ sucesso, resposta? }`. Bloqueio confirmado marca o veículo como bloqueado. |

## Rodar

```bash
cd rastreador
npm install
npm run seed     # opcional: 3 empresas de exemplo com 3 dias de trajetos
npm start        # http://localhost:3400/  (ou RASTREADOR_BASE_PATH=/rastreador → http://localhost:3400/rastreador/) e GT06 na porta 5023
npm test
```

Master inicial: `master@rastreador.com.br` / `master123` (troque com `RASTREADOR_ADMIN_EMAIL` e `RASTREADOR_ADMIN_SENHA`; em produção a senha é obrigatória).
Contas de exemplo do `seed` (senha `demo12345`): `cliente@transportes.demo`, `cliente@entregas.demo`, `cliente@pessoal.demo` e `operador@transportes.demo`.

Configuração: veja [`.env.exemplo`](.env.exemplo). Instalação em servidor (PM2, Docker, cPanel, Nginx/Apache, porta GT06):
`npm run empacotar` gera `dist/rastreador.zip` com o [LEIA-ME](scripts/LEIA-ME.txt).

### Segurança

- O identificador do OsmAnd (celular) funciona como senha: quem souber pode enviar posições por ele. O sistema gera identificadores
  aleatórios (`app-` + 10 dígitos) para os celulares; não use o IMEI de um GT06 num celular.
- O protocolo GT06 não tem autenticação: só o IMEI cadastrado é aceito, e cada IMEI tem uma conexão por vez.
- Bloquear exige digitar a placa. A maioria dos rastreadores só corta o combustível com o veículo abaixo de 20 km/h; o painel avisa
  quando o veículo está mais rápido que isso.
