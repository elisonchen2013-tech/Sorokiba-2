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

A pontuação é transparente: até 70 pontos por respostas, 20 por habilidades do currículo e 10 por experiência. `75+` aprova e contrata, `55–74` aprova para treinamento e abaixo disso recusa. Resultado, feedback, score, contratação e `cooldown_until` ficam em `sk2_career_applications`; tentativas não aprovadas aguardam 24 horas. Contratações ficam em `sk2_players.employment` e aparecem na central.

## Etapa 3: Meu trabalho

Contratações aprovadas nos cargos de recepção hospitalar, atendimento de restaurante e assistência de biblioteca aparecem no painel **Meu trabalho**. O jogador pode falar com o supervisor, iniciar o turno, receber uma tarefa e concluí-la com uma quantidade validada no servidor:

- Hospital: registrar 2 pacientes;
- Restaurante: servir 3 pedidos;
- Biblioteca: catalogar 4 livros.

Endpoints autenticados: `GET /api/sk2/work`, `POST /api/sk2/work/supervisor`, `POST /api/sk2/work/start`, `POST /api/sk2/work/task` e `POST /api/sk2/work/task/complete`. Turnos, tarefas e histórico são persistidos; há no máximo um turno ativo e uma tarefa pendente por conta. Pagamento e XP profissional são calculados pela definição server-side, e a conclusão usa atualização transacional/idempotente para resistir a reenvio após falha de rede.

## Etapa 4: minijogos profissionais

Os mesmos endpoints de trabalho agora suportam tarefas em etapas para três novos fluxos: **Eletricista** (inspeção fictícia, escolha de componente e relatório seguro), **Entregador** (pegar encomenda, confirmar destino e entregar) e **Atendente de fast-food** (montar, conferir restrição e fazer conferência final). As vagas usam os prédios/NPCs já existentes e passam pela entrevista antes da contratação.

As opções exibidas são apenas alternativas seguras; o gabarito e a etapa atual ficam no servidor. `POST /api/sk2/work/task/complete` aceita o índice da opção, valida a etapa, avança a tarefa ou finaliza o pagamento. Cada avanço é persistido e a finalização usa a mesma proteção transacional/idempotente do histórico, sem instruções de elétrica real ou qualquer ação perigosa.

## Testes

```sh
npm test
```

O cliente não cria contas locais quando a API está indisponível. Para testar explicitamente o modo offline de desenvolvimento, use `?devOffline=1` na URL ou defina `window.SK2_DEV_OFFLINE = true` antes de carregar a página.
