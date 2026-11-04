FORGOTTENROOMS ONLINE — PUBLICAÇÃO NO RENDER

ESTRUTURA
- server.js                 servidor Node.js + Socket.IO
- package.json              dependências e comando de inicialização
- public/index.html         jogo original com modo online adicionado
- render.yaml               configuração opcional do Render

COMO PUBLICAR
1. Envie todos os arquivos desta pasta para um repositório do GitHub, mantendo a pasta public.
2. No Render, crie um serviço do tipo Web Service (não Static Site).
3. Conecte o repositório do GitHub.
4. Runtime: Node.
5. Build Command: npm install
6. Start Command: npm start
7. Faça o deploy e abra o endereço .onrender.com gerado pelo Render.

COMO JOGAR ONLINE
1. Os dois jogadores abrem o mesmo endereço do Render.
2. O primeiro toca em MULTIJOGADOR ONLINE, informa seu nome, nome da sala e senha e cria a sala.
3. O primeiro envia o código da sala e a senha ao segundo jogador.
4. O segundo escolhe ENTRAR NA SALA, informa seu nome, código e senha.
5. Quando os dois aparecerem no lobby, o dono da sala toca em INICIAR PARTIDA.
6. Os jogadores aparecem um para o outro com o mesmo uniforme/modelo. Cada um controla o próprio personagem.

OBSERVAÇÕES IMPORTANTES
- Cada sala aceita no máximo 2 jogadores.
- O servidor usa memória para manter as salas. Reiniciar/reimplantar o serviço apaga as salas abertas.
- Mantenha apenas uma instância do serviço. Este projeto ainda não usa banco de dados nem adaptador Socket.IO compartilhado entre várias instâncias.
- Esta primeira versão online sincroniza posição, direção, animação básica e avanço de level. A IA das entidades, itens, inventário e quebra-cabeças ainda funcionam localmente em cada navegador; o progresso detalhado dessas interações não é compartilhado entre os dois jogadores.
- No plano gratuito, o Render pode suspender o serviço após 15 minutos sem tráfego HTTP nem mensagens WebSocket; a próxima conexão pode levar cerca de 1 minuto para reativar o serviço.
