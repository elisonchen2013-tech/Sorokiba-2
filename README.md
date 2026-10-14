# Sorokiba 2

Servidor online do Sorokiba 2, com contas PostgreSQL e multiplayer via WebSocket.

## Setup

Requer Node.js 18 ou superior e PostgreSQL. Instale as dependências com:

```sh
npm install
```

Em desenvolvimento, crie um arquivo `.env` (ou exporte as variáveis no shell):

```sh
DATABASE_URL=postgres://usuario:senha@localhost:5432/sorokiba
SK2_SECRET=uma-chave-secreta-longa
PORT=3000
```

`DATABASE_URL` e `SK2_SECRET` são obrigatórias quando `NODE_ENV=production`. Em desenvolvimento, a ausência delas produz uma mensagem explícita; sem `DATABASE_URL` o banco não pode ser inicializado e o servidor não inicia.

## Executar

```sh
npm start
```

O standalone só abre a porta depois de `db.init()` concluir. O jogo fica em <http://localhost:3000/sorokiba2>.

O health check é:

```sh
curl -i http://localhost:3000/health
```

Retorna `200` com `{"status":"ok","database":"ok"}` quando o banco está acessível e `503` quando a inicialização ou a conexão falha.

Por padrão, o servidor usa o endereço do socket para limites por IP e ignora `x-forwarded-for`. Em uma implantação atrás de proxy confiável, passe `{ trustProxy: true }` ao chamar `attachSorokiba2`.

Após login, a sessão é restaurada por cookie `HttpOnly`, sem gravar token ou senha no `localStorage`. O WebSocket aceita a sessão do cookie e limita conexões por IP e no total; mensagens de movimento/chat também são validadas no servidor.

As missões jogáveis atuais são concluídas por interações reais no cliente, mas sempre validadas por evento permitido no servidor:

- falar com Kiba: missão `welcome`, recompensa R$ 250 e 100 XP;
- entrar no Hospital: missão `hospital_visit`, recompensa R$ 150 e 60 XP;
- ler o quadro de avisos da Prefeitura: missão `cityhall_notice`, recompensa R$ 200 e 80 XP;
- entrar na Biblioteca: missão `library_visit`, recompensa R$ 150 e 60 XP.

Cada objetivo é salvo no PostgreSQL em `sk2_players.missions` e a atualização é atômica, portanto a recompensa não pode ser repetida. O endpoint autenticado é `POST /api/sk2/mission/complete` e aceita somente o par de missão/evento definido no servidor.

## Etapa 1: central de carreiras

O botão **Carreiras** abre uma central jogável com vagas derivadas dos NPCs e prédios existentes (Hospital, Biblioteca, Oficina, Restaurante e Escola). O currículo é persistido em `sk2_players.resume`, pode ser editado pelo painel e aceita apenas até quatro habilidades conhecidas e a experiência liberada pelo XP do jogador. As candidaturas são persistidas em `sk2_career_applications` com chave única por jogador e vaga.

Endpoints autenticados:

- `GET /api/sk2/careers`: catálogo de vagas, currículo e candidaturas atuais;
- `PUT /api/sk2/career/resume`: salva resumo, habilidades e experiência validados pelo servidor;
- `POST /api/sk2/career/apply`: registra uma candidatura somente quando o currículo atende à vaga.

Entrevistas, painel Meu Trabalho, tarefas profissionais e pagamentos recorrentes ainda não fazem parte desta etapa; serão construídos sobre essas candidaturas sem duplicar autenticação ou economia.

## Etapa 2: entrevistas

Cada vaga da central tem três perguntas específicas da profissão. O servidor cria a sessão, controla a ordem e valida cada resposta; o cliente nunca envia ou calcula o gabarito. Os endpoints são:

- `POST /api/sk2/career/interview/start`: inicia ou retoma uma entrevista de candidatura;
- `POST /api/sk2/career/interview/answer`: valida a resposta da pergunta atual;
- `POST /api/sk2/career/interview/finish`: calcula e persiste a pontuação e o resultado.

A pontuação é transparente: até 70 pontos por respostas, 20 por habilidades do currículo e 10 por experiência. `75+` aprova e contrata, `53–74` aprova para treinamento e abaixo disso recusa. Resultado, feedback, score, contratação e `cooldown_until` ficam em `sk2_career_applications`; tentativas não aprovadas aguardam 24 horas. Contratações ficam em `sk2_players.employment` e aparecem na central.

## Etapa 3: Meu trabalho

Contratações aprovadas nos cargos de recepção hospitalar, atendimento de restaurante e assistência de biblioteca aparecem no painel **Meu trabalho**. O jogador pode falar com o supervisor, iniciar o turno, receber uma tarefa e concluí-la com uma quantidade validada no servidor:

- Hospital: registrar 2 pacientes;
- Restaurante: servir 3 pedidos;
- Biblioteca: catalogar 4 livros.

Endpoints autenticados: `GET /api/sk2/work`, `POST /api/sk2/work/supervisor`, `POST /api/sk2/work/start`, `POST /api/sk2/work/task` e `POST /api/sk2/work/task/complete`. Turnos, tarefas e histórico são persistidos; há no máximo um turno ativo e uma tarefa pendente por conta. Pagamento e XP profissional são calculados pela definição server-side, e a conclusão usa atualização transacional/idempotente para resistir a reenvio após falha de rede.

## Etapa 4: minijogos profissionais

Os mesmos endpoints de trabalho suportam tarefas em etapas para **Eletricista** (inspeção fictícia, escolha de componente e relatório seguro), **Entregador** (pegar encomenda, confirmar destino e entregar), **Atendente de fast-food** (montar, conferir restrição e conferir o pedido), **Mecânico** (inspeção virtual e relatório de serviço) e **Assistente escolar** (preparo de materiais, apoio a alunos e registro de atividade). As vagas usam os prédios/NPCs já existentes e passam pela entrevista antes da contratação.

As opções exibidas são apenas alternativas seguras; o gabarito e a etapa atual ficam no servidor. `POST /api/sk2/work/task/complete` aceita o índice da opção, valida a etapa, avança a tarefa ou finaliza o pagamento. Cada avanço é persistido e a finalização usa a mesma proteção transacional/idempotente do histórico, sem instruções de elétrica real ou qualquer ação perigosa.

## Etapa 5: progressão profissional

O painel **Meu trabalho** mostra a escada de cargos, salário mensal, XP profissional, tarefas concluídas e desempenho médio. Cada profissão possui três cargos com requisitos transparentes de XP, tarefas e desempenho; tarefas concluídas em cargos superiores recebem recompensa maior.

Treinamentos são desbloqueados por XP profissional e concluídos pelo endpoint `POST /api/sk2/work/training/complete`. Promoções usam `POST /api/sk2/work/promotion/request` e `POST /api/sk2/work/promotion/confirm`: ambos recalculam os requisitos no servidor, e a confirmação atualiza `employment` e registra `sk2_work_promotions` em transação, sem aceitar cargo/salário enviados pelo cliente. Solicitações, treinamentos e promoções têm chaves únicas para evitar duplicação.

## Expansão da cidade e requisitos de carreira

A cidade foi ampliada de 96 × 68 para 96 × 84 células, com uma nova região ao sul e um prédio explorável chamado **Centro de Empregos**. O interior agora separa visualmente e por colisão a recepção, sala de espera, recrutamento, painel de vagas, orientação profissional e sala de entrevistas, com portas e placas identificando cada setor. Há uma NPC entrevistadora dedicada. Falar com o recrutador, a entrevistadora ou interagir com o painel de vagas abre a central existente, reaproveitando currículo, candidaturas e entrevistas persistidas. O editor de currículo utiliza campos de alto contraste, contador de caracteres e preserva rascunhos não salvos durante atualizações da central. Os controles também detectam automaticamente dispositivos com ponteiro de toque ou touchscreen: PC mantém teclado e botão E, enquanto celular/tablet exibe joystick virtual para movimentação e botão de interação adaptado à tela. Em celulares e tablets em modo retrato, o jogo tenta solicitar a orientação horizontal usando a API do navegador e tela cheia; quando o navegador não permite bloquear a rotação, exibe uma tela de instrução para girar o aparelho. O visual recebeu pós-processamento CSS sutil e animações respeitando a preferência de movimento reduzido. Os veículos freiam diante do jogador na faixa, impedem atravessamento por colisão e acionam buzina com indicador visual quando ficam bloqueados. O trânsito foi refinado com frenagem antecipada nos semáforos, velocidade ajustada ao veículo da frente e bloqueio preventivo das faixas próximas a acidentes para evitar colisões em cadeia. Se ocorrer uma sobreposição real entre dois veículos, o jogador que controla o trânsito registra um acidente validado e compartilhado pelo servidor: os carros ficam imobilizados, surge fogo e fumaça estilizados, NPCs próximos fogem, e polícia, ambulância e bombeiros chegam alguns segundos depois. Os semáforos usam um relógio de parede comum aos navegadores. Quando há um NPC perto do acidente, ele permanece junto à ocorrência enquanto aguarda a ambulância; os demais pedestres próximos fogem. Os bombeiros lançam água e o fogo se apaga; a ambulância percorre as ruas até a entrada do Hospital e o NPC atendido reaparece lá após o transporte. O Parque Central fica na região sul e inclui gramado, trilhas, lago decorativo, árvores, iluminação e quatro bancos interativos: pressione E para sentar e E novamente ou comece a andar para levantar. A pose sentada é compartilhada no multiplayer. O trânsito compartilha snapshots dos 36 carros: um jogador designado simula e publica suas posições, o servidor valida e retransmite o estado e troca o responsável se ele sair. O parque agora tem bancos com uma pose realmente sentada e âncoras corrigidas para alinhar o personagem ao assento; os avatares sentados são renderizados na mesma altura da superfície do banco, inclusive para os demais jogadores. A Sorveteria do Parque tem a funcionária Luna e cinco sabores: baunilha, chocolate, morango, flocos e pistache. Comprar desconta dinheiro no servidor, guarda unidades no inventário persistente e permite comê-las depois; comer consome uma unidade e mostra uma animação. Só o Prefeito vê o botão “Testar acidente”; o servidor também verifica o cargo e aplica um tempo de espera antes de iniciar uma ocorrência compartilhada com fogo, evacuação e veículos de emergência.

Cada profissão tem um requisito de XP geral verificado pelo servidor: Entregador 0 XP; Fast-food 50 XP; Recepcionista hospitalar, atendente de restaurante e assistente de biblioteca 100 XP; Mecânico 250 XP; Eletricista 300 XP; Assistente escolar 400 XP. A central mostra o progresso e impede candidaturas sem XP suficiente. O XP profissional continua separado e é usado para a progressão dentro da carreira.

As carreiras de **Mecânico** e **Assistente escolar** também passaram a ter tarefas jogáveis em etapas e trilhas de cargos, alinhando o catálogo de empregos aos sistemas de trabalho.

## Testes

```sh
npm test
```

O cliente não cria contas locais quando a API está indisponível. Para testar explicitamente o modo offline de desenvolvimento, use `?devOffline=1` na URL ou defina `window.SK2_DEV_OFFLINE = true` antes de carregar a página.
