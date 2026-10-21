# PABX

Painel de gestão de PABX em nuvem, publicado em `/pabx`, com dois níveis de acesso:

| Perfil | O que vê |
|---|---|
| **Master** | A plataforma inteira: empresas, chamadas de todas, usuários e permissões, segurança, relatórios, terminação (operadoras e números), diagnóstico, configurações e integrações. Entra no painel de qualquer empresa pela lista de Empresas. |
| **Suporte** | Como o master, sem usuários, segurança e configurações; só consulta a terminação e as chaves de API e não exclui empresas. |
| **Cliente** (administrador da empresa) | O painel da própria empresa: dashboard, supervisão de campanhas, campanhas, pessoas/ramais, chamadas, CRM, terminação, números entrantes, recursos PABX, relatórios, configurações e integrações. |
| **Supervisor** | O painel da empresa só para consulta (não altera nada e não vê senhas nem chaves). |

O painel cuida do cadastro e do acompanhamento. **Quem faz as ligações é a central telefônica** (Asterisk, FreeSWITCH ou outra),
que busca a configuração e informa cada chamada pela [API de integração](#api-de-integração).

Servidor próprio (Node.js + SQLite), sem depender do Ativa BPO nem do APP Táxi. Tema escuro por padrão, com o claro no botão do topo.

## Telas

### Master
- **Dashboard**: empresas ativas, chamadas agora, ramais online, faturamento; utilização (recebidas, realizadas e gastos de hoje e do mês),
  chamadas simultâneas ao longo do dia, ramais online/offline, uso do mês por tipo de destino, empresas com mais chamadas e TTS/STT.
- **Empresas**: filtro por nome, tipo e status; ramais (ativos/limite), chamadas online/total de hoje, uso do disco das gravações;
  **editar** (dados, limites, rota de saída e tarifas), **bloquear/desbloquear** (com motivo) e **excluir** (confirmando o nome).
  Clicar na empresa abre o painel dela (`Empresas / NOME / Dashboard`).
- **Chamadas**: todas as empresas, com filtros, detalhe e CSV.
- **Permissões e usuários**: usuários da plataforma e das empresas, perfil, ativo/inativo e troca de senha. Sempre sobra um master ativo.
- **Segurança**: logins recusados nas últimas 24 h, **bloqueio de IP** (o IP bloqueado não acessa o painel nem a API) e o registro de atividades.
- **Relatórios**: por dia, por tipo de destino e **por empresa**, com CSV e impressão.
- **Terminação**: rotas de saída (operadoras: host, usuário, canais e custo por minuto) e o estoque de **números (DIDs)**, atribuídos às empresas.
- **Diagnóstico**: verificações (banco, contato da central telefônica, registro de ramais, chamadas presas, empresas sem rota, números sem destino,
  disco cheio, empresas no limite de canais) e o estado das rotas.
- **Configurações**: nome da plataforma, cadência da tarifação (ex.: 30/6), padrões das empresas novas e tempos da central telefônica.
- **Integrações**: chaves de API de todas as empresas e o guia da API.

### Cliente
- **Dashboard**: os cartões Utilização, Chamadas Simultâneas, Ramais, Uso mês atual, Recursos de voz e texto (TTS/STT) e Limites.
- **Supervisão de campanhas**: progresso de cada campanha e cada agente (livre, em chamada, offline), atualizando sozinha.
- **Campanhas** (discador): modo, fila que atende, canais e tentativas; importação de contatos ("nome;telefone"), ativar, pausar e encerrar.
- **Pessoas / Ramais**: cadastro dentro do limite contratado, gravação por ramal, situação do registro e os dados SIP para configurar o telefone.
- **Chamadas**: lista com filtros (período, direção, status, ramal, número ou contato), detalhe e CSV.
- **CRM**: contatos com o histórico de chamadas; o nome aparece na lista de chamadas.
- **Terminação**: rota, cadência, preço por minuto e consumo do mês.
- **Números Entrantes**: para onde vai cada número (ramal, fila ou URA).
- **Recursos PABX**: filas de atendimento (ramais e distribuição) e URAs (mensagem e opções por tecla).
- **Relatórios**: por dia, por tipo de destino e por ramal.
- **Configurações**: contato, gravação, plano contratado e usuários da empresa (administrador e supervisor).
- **Integrações**: chaves de API da empresa.

## Tarifação e limites

- Só as ligações **realizadas e atendidas** são cobradas. O tipo vem do número discado: móvel (9 dígitos começando com 9), fixo,
  internacional (`00…`) ou interno (ramal).
- Tempo cobrado na cadência configurada (padrão **30/6**: mínimo de 30 s, depois a cada 6 s) × preço por minuto da empresa.
- A central telefônica recebe **429** ao passar do limite de chamadas simultâneas e **403** com a empresa bloqueada. Sem espaço em disco,
  a resposta do início da chamada diz `gravar: false`. TTS e STT são recusados acima do limite do mês.
- Chamadas que a central não encerrou em 6 h viram "falha"; ramais sem registro há 10 min ficam offline (ajustável em Configurações).

## API de integração

Autenticação pela chave da empresa (Integrações → Nova chave) no cabeçalho `X-Api-Key`. Base: `https://SEU-DOMINIO/pabx/api/integracao`.

| Método e caminho | Para quê |
|---|---|
| `GET /config` | Ramais (com usuário e senha SIP), números e destinos, filas com os ramais, URAs e a rota de saída. |
| `POST /chamadas` | Início: `{ uid, direcao: entrada\|saida\|interna, origem, destino, ramal?, numero?, campanha_contato_id?, inicio? }` → `{ id, gravar }`. |
| `POST /chamadas/:uid/atendida` | Atendimento: `{ em? }`. |
| `POST /chamadas/:uid/fim` | Fim: `{ status?: atendida\|nao_atendida\|ocupado\|falha, fim?, gravacao_bytes? }` → duração, custo. |
| `POST /ramais/:numero/registro` | Telefone conectou/desconectou: `{ online, ip?, agente? }`. |
| `POST /recursos` | Uso de TTS/STT: `{ recurso: tts\|stt, quantidade }`. |
| `POST /campanhas/:id/proximos` | Discador: próximos contatos a ligar (até os canais livres), já marcados como "discando". |

Repetir a mesma mensagem (mesmo `uid`) não duplica a chamada.

## Rodar

```bash
cd pabx
npm install
npm run seed     # opcional: 3 empresas de exemplo com chamadas do mês
npm start        # http://localhost:3300/  (ou PABX_BASE_PATH=/pabx → http://localhost:3300/pabx/)
npm test
```

Master inicial: `master@pabx.com.br` / `master123` (troque com `PABX_ADMIN_EMAIL` e `PABX_ADMIN_SENHA`; em produção a senha é obrigatória).
Contas de exemplo do `seed` (senha `demo12345`): `cliente@cobranca.demo`, `cliente@clinica.demo`, `cliente@loja.demo` e `supervisor@cobranca.demo`.

Configuração: veja [`.env.exemplo`](.env.exemplo). Instalação em servidor (PM2, Docker, cPanel, Nginx/Apache): `npm run empacotar`
gera `dist/pabx.zip` com o [LEIA-ME](scripts/LEIA-ME.txt).
