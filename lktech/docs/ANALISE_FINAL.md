# Análise final do site LK TECH

Data: 27/11/2026. Situação: pronto para instalar no VPS assim que ele for entregue.

## Análise de tela

O site e o painel foram abertos automaticamente em 8 larguras: 360, 390, 414, 768, 1024, 1280, 1440 e 1920 px. Em cada uma foi medido:

| Verificação | Resultado |
|---|---|
| Rolagem para o lado | nenhuma, em todas as larguras (site e painel) |
| Margens esquerda/direita das seções | simétricas em todas as larguras |
| Erros no console do navegador | nenhum |
| Imagens quebradas ou requisições com falha | nenhuma |
| Texto menor que 12 px | nenhum |
| Botões menores que 40 px no celular | nenhum (menu, setas, rodapé, fechar e caixas de marcar ajustados) |
| Textos no tamanho máximo do painel, inclusive palavras sem espaço | nada sai da caixa; cartões de plano com mesma altura e preço e botão alinhados; banner não muda de altura ao trocar |
| Um plano só | cartão centralizado, sem setas |

Também foram conferidos:

- menu do celular (abre e fecha, e fecha com Esc);
- formulário de contato;
- consulta de CEP;
- rotação dos planos, com botão de pausa;
- página 404 em português;
- prévia sem login, que leva ao painel.

### Ajustes feitos nesta etapa

- **Painel no celular:** o menu de seções ficava cortado de lado. Agora é um botão que abre todas as seções em duas colunas.
- **Contatos recebidos no celular:** a tabela virou cartões.
- **Tempo de rotação:** passou a ser informado em segundos, em vez de milissegundos.
- **Celular:** botões aumentados para no mínimo 44 px.
- **Foto do banner:** passou de PNG de 2,1 MB para JPG de 205 KB, com a mesma aparência. Agora só a foto da tela em uso é pré-carregada.

## Análise de código

Feita por um revisor independente e confirmada com testes. Não houve nenhum achado crítico: nenhuma falha de XSS, travessia de diretório ou desvio de login.

Verificado e correto:

- proteção contra envio de outro site (CSRF/origem);
- exportação CSV protegida contra fórmulas;
- upload que recusa SVG;
- escape de todo o conteúdo do painel;
- limite de tentativas de login.

### Corrigido

| Achado | Correção |
|---|---|
| Publicar não conferia o conteúdo; conteúdo antigo podia derrubar o site | Publicar valida tudo. Conteúdo antigo é ajustado aos limites ao ser exibido ou restaurado |
| Arquivos JS e CSS guardados por 1 hora no navegador: depois de uma atualização, o site podia misturar versões e travar | O navegador confere a versão a cada visita (ETag) |
| Limite de login contornável com IPv6; logins em massa podiam deixar o site lento | Limite por rede IPv6 /64 e por e-mail, e no máximo 2 conferências de senha ao mesmo tempo |
| Instalador só voltava a versão anterior se o site não respondesse | Qualquer falha após a troca volta a versão e a configuração anteriores e confere de novo |
| Instalador podia parar antes de mostrar o IP, se o e-mail do administrador estivesse errado | Pergunta até 3 vezes e segue |
| Instalador: perguntas do apt, porta SSH fixa em 22, domínio não atualizado ao reinstalar | Corrigido. Detecta a porta do SSH e mantém o domínio sincronizado |
| Contatos (dados pessoais) sem como excluir (LGPD) | Botão **Excluir** no painel |
| Conflito de edição sem saída | O painel oferece carregar a versão mais recente |
| Rotação dos planos sem pausa; botão de pausa do banner sem rotação | Pausa nos planos. O botão só aparece quando há rotação |
| Imagem de celular usada entre 601 e 700 px | Mesmo ponto de quebra (600 px) no HTML e no CSS |
| Endereço inexistente mostrava texto técnico; servidor parado mostrava página em branco | Página 404 em português. Página "Voltamos em instantes" no HTTPS |
| CEP com hífen era recusado no cadastro de regiões | Aceita "01000-000"; mensagens de erro mais claras |
| Política de segurança permitia estilos embutidos | Removida a permissão (não era usada) |

### Pontos que dependem do ambiente final

- O instalador não pôde ser executado de ponta a ponta neste ambiente de testes, porque as regras de permissão bloquearam a simulação. A primeira execução real será no VPS.
- A configuração do HTTPS (Caddy) é conferida pelo próprio instalador antes de ser aplicada. Se houver erro, nada é alterado.
- Os testes automáticos rodaram em Node.js 22. O VPS usa Node.js 24, a versão pedida pelo projeto, e o instalador roda os testes nele antes de ligar o site.

## Testes automáticos

`npm test`: 6 testes, todos aprovados. Cobrem:

- login;
- bloqueios de acesso;
- rascunho, prévia e publicação;
- limites do painel;
- cores e logo fixos;
- conteúdo antigo;
- restauração;
- exclusão de contatos;
- domínio, `www` e Google;
- página 404;
- versão dos arquivos;
- upload, CEP, contatos e CSV.

## Segunda revisão completa (27/11/2026, servidor já instalado)

### Telas
71 combinações verificadas, de 320×568 a 2560×1440, incluindo celular deitado e notebooks de 1280×720 e 1366×768. Nenhum problema: sem rolagem lateral, sem erros, margens simétricas e o banner com o botão principal sempre visível na primeira tela.

Ajustes desta etapa:
- **Celulares pequenos e deitados:** o banner ficava maior que a tela. Agora a foto acompanha a altura da tela.
- **Painel em tablet:** a tabela de contatos virou cartões também nessa largura.

### Segurança e código (revisor independente; nenhum achado crítico)
| Achado | Correção |
|---|---|
| Qualquer pessoa podia trancar o administrador fora do painel com 10 senhas erradas no e-mail dele | Conta só erros e zera ao acertar. O bloqueio é por endereço de origem; no e-mail as tentativas só ficam mais lentas |
| Sessão de 8 horas fixas: ao vencer, as alterações não salvas sumiam | A sessão é renovada enquanto o painel é usado. Se vencer, o painel oferece recuperar as alterações |
| `$` no título ou na descrição de busca bagunçava o HTML da página | Corrigido |
| Corpo inválido (`null`, item vazio em lista) gerava erro 500 | Resposta 400, sem erro no servidor |
| Conteúdo gravado com itens ou campos faltando podia derrubar o site | O ajuste completa os campos, descarta itens inválidos, garante um banner ativo e normaliza os tempos |
| CSV com data em UTC e situação em código interno | Data no horário de Brasília e situação por extenso |
| Contador de contatos limitado aos 1000 mais recentes | Contagem real. O painel avisa quando a lista mostra só os 1000 mais recentes |
| Troca de senha sem limite de tentativas | 5 erros a cada 15 minutos |
| Fotos JPG de alguns celulares eram recusadas | Aceitas |
| Endereço malformado mostrava texto técnico | Página de erro em português |
| Firewall: na nuvem Oracle o ufw não tem efeito | O instalador usa o firewall próprio do servidor (iptables) e libera SSH, 80 e 443 |
| Configuração antiga podia deixar o site acessível fora do proxy | O instalador força `HOST=127.0.0.1` e `TRUST_PROXY=true`, e o código usa 127.0.0.1 como padrão |
| Queda do SSH no meio da atualização | A versão anterior volta sozinha |
| Proteções do serviço | Restrições extras no systemd (UMask, ProtectClock, ProtectProc, MemoryMax, entre outras) |
| Cabeçalhos | O site não pode ser exibido dentro de outro site (DENY e frame-ancestors 'none'); COOP; cookie restrito ao painel |
| Spam de contatos | Teto geral de 300 pedidos por hora e índice na tabela de limites |

Testes automáticos: 7, todos aprovados.
