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

O botão **Carreiras** abre uma central jogável com vagas derivadas dos NPCs e prédios existentes (Hospital, Biblioteca, Oficina, Restaurante, Escola e Delegacia). O currículo é persistido em `sk2_players.resume`, pode ser editado pelo painel e aceita apenas até quatro habilidades conhecidas e a experiência liberada pelo XP do jogador. As candidaturas são persistidas em `sk2_career_applications` com chave única por jogador e vaga.

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

## Sorokiba Tower

A corretora Marta e os elevadores abrem o painel imobiliário durante a exploração do térreo. O painel mostra as 60 unidades em 15 andares, seus layouts A–D, tamanhos, proprietários e preço de tabela; as propostas de compra são negociadas e validadas no servidor. As plantas internas seguem os quatro modelos do ZIP, com cozinha, sala, quartos e banheiro conforme a unidade. Proprietários recebem uma decoração inicial gratuita, podem posicionar, girar e remover móveis na planta isométrica e liberar ou fechar visitas; somente unidades abertas exibem a planta decorada aos visitantes. A cena 2.5D do térreo continua integrada, com seus ambientes comuns e elevadores.

Rotas autenticadas: `GET /api/sk2/condo`, `GET /api/sk2/condo/unit/:id`, `POST /api/sk2/condo/negotiate`, `POST /api/sk2/condo/buy`, `POST /api/sk2/condo/layout` e `POST /api/sk2/condo/open`. A inicialização cria `sk2_units` sem alterar tabelas de outros sistemas.

## Banco de Sorokiba

O interior do Banco (Marcos no caixa, Ana na gerência e o caixa eletrônico) abre o painel bancário. Segue a lógica do condomínio: tudo é validado e gravado no servidor, o dinheiro só muda dentro de transação com `FOR UPDATE`, e as tabelas são próprias (`sk2_bank_accounts`, `sk2_bank_ledger`, `sk2_bank_loans`), criadas por `bank.init()` sem alterar tabelas de outros sistemas. Código em `sorokiba2-bank.js`; as regras ajustáveis ficam no objeto `BANK` no topo.

- **Poupança**: depositar e sacar. Rende 0,5% ao dia sobre até R$ 50.000, creditado por dia completo (no máximo 30 dias por visita). Teto de R$ 1.000.000.
- **Transferências** entre jogadores: exigem 100 XP, limite de R$ 5.000 por 24 h e tarifa (2% por padrão, mínimo R$ 1) que vai para o tesouro da Prefeitura e pode ser alterada por lei. O destinatário recebe um aviso em tempo real pelo WebSocket.
- **Empréstimo** (exige 100 XP): limite cresce com o XP (R$ 300 + 5 por XP, até R$ 5.000), um ativo por jogador, prazo de 7 dias. A Ana negocia a taxa de tabela (12%) em até 5 rodadas, como a Marta negocia o preço. Empréstimo vencido é cobrado da poupança e depois da carteira, no próximo uso do banco ou pela varredura do servidor a cada 10 minutos.
- **Extrato** com as últimas 20 movimentações.

Endpoints autenticados: `GET /api/sk2/bank`, `POST /api/sk2/bank/deposit`, `/withdraw`, `/transfer`, `/loan/negotiate`, `/loan/take` e `/loan/repay`.

Limitação atual: o servidor ainda não sabe em qual prédio o jogador está (só salas com `net` são informadas), então as rotas do banco não exigem presença física no Banco. Isso entra junto com a validação de posição dos interiores.

## Hospital de Sorokiba

O Hospital segue a estrutura do condomínio: planta própria em tiles (`HZ` no HTML, como o `CONDO_ZIP`), paredes com portas sinalizadas, colisão derivada da planta e câmera que segue o jogador com zoom de 1,3. São nove áreas (recepção e espera, triagem, dois consultórios, laboratório, imagem, pronto-socorro e internação) e oito funcionários. As enfermeiras andam até o paciente e usam o instrumento de cada etapa (termômetro, estetoscópio, braçadeira, seringa, varredura de imagem, soro). Código do servidor em `sorokiba2-hospital.js`; as regras ajustáveis ficam em `HOSPITAL`, `DISEASES` e `EXAMS` no topo.

Todo o estado vive no servidor (`sk2_hospital_patients`, `sk2_hospital_conditions`, `sk2_hospital_visits`, `sk2_hospital_exams`), então o jogador pode sair do jogo no meio do atendimento e voltar horas depois.

- **Doenças por chance**: a cada 30 minutos reais há um sorteio (4%) entre sete doenças (resfriado, intoxicação, gripe, fratura, pneumonia, apendicite e câncer, este bem raro). Os sorteios acumulam enquanto o jogador está fora, no máximo 8. Sem tratamento, a gravidade sobe a cada 6 horas e a saúde cai por hora.
- **Fluxo do paciente**: Recepção (ficha e senha) → Triagem (sinais vitais e cor de risco; vermelho passa na frente) → Consulta (R$ 40, hipóteses e pedido de exames) → Exames (cada um na sua sala, de 1 a 2 horas reais) → Resultados e diagnóstico → plano de tratamento (padrão ou intensivo) → sessões no Pronto-socorro ou na Internação, com intervalo entre sessões (a quimioterapia tem 3 sessões de 3 h) → Alta. Cada etapa só abre depois da anterior, e o valor é cobrado na hora, em transação.
- **Integração**: quem está com saúde abaixo de 35% não começa turno de trabalho (`/api/sk2/work/start`); ao entrar no jogo o cliente avisa se o jogador está doente; exames prontos geram aviso em tempo real pelo WebSocket, mesmo fora do hospital.
- **Teste rápido**: `SK2_HOSPITAL_TIME_SCALE=0.01` comprime exames, esperas e sessões. Em produção deixe sem definir.

Endpoints autenticados: `GET /api/sk2/hospital`, `POST /api/sk2/hospital/checkin`, `/triage`, `/consult`, `/exams/collect`, `/exams/results`, `/treatment/plan`, `/treatment/session`, `/leave` e os serviços `/service/plan`, `/service/vaccine`, `/service/donate` e `/service/snack`.

**Atualização do Hospital**

- **Resumo da última visita**: depois da alta (saudável, curado ou encerrado) o painel mostra o resultado do atendimento por 30 minutos, em qualquer sala. Antes, quem recebia alta na consulta via "abra a ficha na Recepção".
- **Guia "aprenda aonde ir"**: linha animada no chão até o próximo destino, marcador na sala, barra no topo com a sala atual e o passo seguinte, TV da recepção com a senha e o destino, e botão para ligar/desligar o guia. Durante a espera pela consulta, o guia leva ao assento mais próximo.
- **Sentar**: 27 assentos (sofás da recepção e do corredor, poltronas, cadeiras dos consultórios, banquinho do laboratório, cadeiras de rodas). `E` perto do assento senta; andar ou `E` levanta. Fica só no cliente, como os bancos da cidade.
- **Objetos com ação**: bebedouros, álcool em gel, balança, pia, TV e mural de saúde (dicas), aquário. Mais decoração: relógio de parede em tempo real, tapetes, suportes de soro, mesas de centro.
- **Máquina de lanches** (`POST /api/sk2/hospital/service/snack`): água R$ 3, café R$ 5, sanduíche R$ 9; recuperam um pouco de saúde, com intervalo de 5 minutos entre compras. Não cura doença.
- **Serviços para quem está saudável**: plano de saúde (50% em consultas, exames e sessões por 7 dias, R$ 250), vacina (a chance de adoecer cai para 1/4 por 12 horas, R$ 80) e doação de sangue (R$ 50 e 20 XP, intervalo de 6 h, exige saúde de 70% ou mais).

Limitação atual: como no Banco, o servidor não sabe em qual sala o jogador está; a ordem das etapas, os prazos e as cobranças são garantidos no servidor, mas o deslocamento entre salas é guiado só pelo cliente.

## Prefeitura de Sorokiba

A Prefeitura tem dois andares, cada um com planta própria de 40×24 tiles (mesma técnica do condomínio e do hospital: paredes com portas sinalizadas, colisão derivada da planta, câmera que segue o jogador com zoom). **Térreo**: saguão com selo da cidade no piso, recepção, escadaria e elevador, Protocolo, Sala de Avisos, Sala Eleitoral e Segurança e Trânsito. **2º andar**: átrio, Gabinete do Prefeito, Vice-prefeitura, Secretaria de Finanças, Secretaria de Saúde e Plenário da Câmara. Cada mesa mostra uma placa com o cargo e o nome de quem o ocupa. Código do servidor em `sorokiba2-city.js`; as regras ajustáveis ficam em `CITY`, `POLICIES` e `OFFICES` no topo.

**Cargos e funções** (permissões em `PERMS`, sempre checadas no servidor):

- **Prefeito**: painel completo da cidade, nomeia e exonera vice e secretários, propõe leis, publica avisos oficiais e abre a Central da Prefeitura (trânsito, acidentes, comunicado global, saldo, redefinição de senha).
- **Vice-prefeito**: publica avisos e propõe leis.
- **Secretário de Finanças**: aprova ou nega pedidos de auxílio, pagos pelo tesouro. Não decide o próprio pedido.
- **Secretário de Saúde**: define o subsídio do Hospital, dentro do teto fixado por lei.
- **Secretário de Segurança e Trânsito**: simula acidentes e congestionamento (antes só o Prefeito).
- **Vereadores (3)**: eleitos pelos moradores, votam as leis no Plenário.

**Economia e leis.** O tesouro recebe a tarifa de transferência do Banco e a receita do Hospital, e paga auxílios e salários dos cargos (por dia completo, acumulando no máximo 3 dias). Três políticas mudam só por lei: tarifa do Banco (0 a 5%), teto do subsídio da saúde e teto do auxílio. A lei vai a votação por 24 h e precisa de maioria das cadeiras; sem vereadores, vira decreto na hora. O Banco passa a ler a tarifa da política e o Hospital passa a aplicar o subsídio, que se acumula com o plano de saúde (o preço mostrado na tela e o cobrado são calculados pela mesma fórmula inteira).

**Eleição.** Sempre há uma eleição aberta (7 dias). Candidatura exige 100 XP e voto exige 50 XP, um voto por morador e nenhum em si mesmo. Na apuração assumem os 3 mais votados (empate pela candidatura mais antiga); quem já tem outro cargo é pulado.

**Dados e gráficos.** O servidor guarda uma amostra da cidade (moradores, online, dinheiro em circulação, poupanças, dívidas, tesouro, doentes, empregados, saúde média) a cada 10 minutos e também ao abrir a Prefeitura. A tela do saguão mostra os números públicos; os cargos veem o painel completo, com seis gráficos desenhados em canvas.

Endpoints autenticados: `GET /api/sk2/city` e `POST /api/sk2/city/...` com `notice`, `office/appoint`, `office/dismiss`, `law/propose`, `law/vote`, `policy/subsidy`, `aid/request`, `aid/decide`, `salary/claim`, `election/candidate` e `election/vote`. `SK2_CITY_TIME_SCALE=0.001` comprime os prazos para teste.

Limitações atuais: se o Prefeito sair, não há sucessão automática; o servidor não sabe em qual sala o jogador está (como no Banco e no Hospital); a doação de sangue do Hospital ainda é paga com dinheiro novo, não pelo tesouro.

## Delegacia de Sorokiba

A Delegacia é um piso único de 46×26 tiles, com a mesma técnica da Prefeitura (paredes com portas sinalizadas, colisão derivada da planta, câmera com zoom), mas com visual próprio: paredes claras com faixa âmbar e verde-água, piso azul-noite, letreiro neon, sirene giratória na entrada e no telhado, parede de câmeras com um radar que mostra os jogadores online, relógio real, espelho unidirecional, celas com grades e perícia com luz ultravioleta. Paredes que ficam na frente do jogador ficam quase transparentes, para ele não sumir atrás delas.

**Salas e o que cada uma faz** (todas as telas abrem pelos NPCs ou pelos pontos do prédio; as regras vivem em `sorokiba2-police.js`):

- **Saguão · Balcão de Atendimento** (Sargento Ramos): registrar Boletim de Ocorrência (B.O.), acompanhar os seus registros e validar uma certidão pelo código. **Mural de Alertas**: avisos de segurança e números da cidade.
- **Multas e Trânsito** (Cabo Iara): ver, pagar e contestar as suas multas; a aba *Aplicar multa* aparece só para policiais e Delegado; tabela de infrações com as regras.
- **Central de Despacho** (Soldado Vitor): fila de ocorrências para policiais assumirem, andamento do caso e números gerais. Parede de câmeras e radar.
- **Identificação** (Perita Nina): certidão de antecedentes (R$ 15 para o tesouro), com leitura de digital animada. NADA CONSTA só sem multa pendente ou vencida. Cada certidão tem código `SK-XXXXXXXX` que qualquer morador valida no balcão.
- **Interrogatório** (Detetive Caio) e **Evidências** (Perito Otto): etapas obrigatórias de cada caso, com animações de gravação e de análise.
- **Gabinete da Delegada** (Mara): decide contestações, publica alertas (com transmissão opcional a todos os jogadores), vê equipe e painel de 7 dias.
- **Carceragem**: três celas decorativas e um figurante. Não existe prisão de jogadores.

**Quem faz o quê** (permissões em `PERMS`, sempre checadas no servidor):

- **Delegado(a)**: o Secretário de Segurança e Trânsito (ou o Prefeito). Decide contestações, cancela multas, publica alertas, vê equipe e painel.
- **Agente**: quem foi contratado na nova carreira **Policial** (`police_officer`, Centro de Empregos, 200 XP e 1 de experiência, 3 vagas, três cargos: Agente de patrulha, Agente sênior e Inspetor; turno com ronda em três etapas). Assume e encerra ocorrências e aplica multas dentro do catálogo.
- **Cidadão**: registra B.O., paga ou contesta multas, tira certidão.

**Caso de ocorrência.** Fila → o agente assume (um por vez) → depoimento na Sala de Interrogatório → espera da perícia (1 min) → análise das provas na Sala de Evidências → parecer. A ordem das etapas é validada no servidor. *Resolvido* exige as duas etapas; *arquivado* pode ser feito a qualquer momento. Caso parado por 24 h volta à fila. Ninguém pode assumir o próprio B.O.

**Multas sem incentivo para abuso.** O valor vem do catálogo `INFRACTIONS` (o agente nunca digita valor). Agente iniciante só aplica multas até R$ 60. Moradores com menos de 100 XP recebem só advertência. Limites: 2 multas por alvo e 8 autuações por agente em 24 h, e 6 h entre autuações do mesmo par. Prazo de 72 h; depois dele, acréscimo único de 10%. Toda multa pode ser contestada uma vez e quem decide é o Delegado (que não decide a própria). **O agente não ganha comissão de multa.** O dinheiro vai para o tesouro (`multa` no extrato da Prefeitura). Cada caso resolvido paga R$ 30 e 20 XP pelo tesouro, com teto de 6 por dia e 1 por par agente/denunciante por dia.

Endpoints autenticados: `GET /api/sk2/police` e `POST /api/sk2/police/...` com `report`, `case/take`, `case/release`, `case/step`, `case/close`, `fine/issue`, `fine/pay`, `fine/contest`, `fine/decide`, `fine/cancel`, `alert` e `cert/issue`; `GET /api/sk2/police/cert/:code` valida uma certidão. Tabelas: `sk2_police_reports`, `sk2_police_fines`, `sk2_police_alerts` e `sk2_police_certs`, criadas em `police.init()`. Avisos ao vivo chegam pelo WebSocket como `{t:'police'}`. `SK2_POLICE_TIME_SCALE=0.001` comprime prazos e esperas para teste.

Limitações atuais: como no Banco, no Hospital e na Prefeitura, o servidor não sabe em qual sala o jogador está (a ordem das etapas do caso é validada, mas não o lugar físico); não há prisão nem pena além de multa; as rotas e o SQL da Delegacia têm testes de regras e de ligação, mas as consultas ao PostgreSQL ainda não foram exercitadas contra um banco real.

## Mercado de Sorokiba

O Mercado e o Supermercado usam o mesmo interior (40×24 tiles, piso único) e a mesma loja: `sorokiba2-market.js`. Padaria, Loja, Farmácia, Shopping e Lavanderia continuam com o interior genérico.

**O que tem no prédio:** porta automática que desliza quando você chega perto, hortifruti com névoa, padaria com forno aceso e fornadas que saem de tempos em tempos, parede de geladeiras (laticínios, bebidas e congelados) com portas que abrem, gôndolas com mercadorias coloridas e placas de corredor, freezers, ilhas de promoção com selo giratório, quadro de ofertas em LED, três caixas com esteira e leitor a laser (um deles fechado), autoatendimento, balcão de atendimento, estoque, carrinhos e cestas na entrada e clientes empurrando carrinhos pelos corredores. Gôndolas e paredes na frente do jogador ficam translúcidas para ele não sumir atrás delas.

**Sons** (tudo gerado no navegador, respeitam o botão de som):

- Entrada e saída: campainha de duas notas e porta deslizando; a porta também faz som ao abrir e fechar quando você passa por ela.
- Carrinho ou cesta: chacoalhar ao pegar e batida ao devolver; com carrinho, o passo no piso ganha um chocalho.
- Compras: "pop" ao pôr no carrinho, som invertido ao tirar, buzina curta quando enche ou falta saldo, bipes do leitor a cada item no caixa, "ka-ching" na compra paga e barulho de sacola.
- Ambiente: zumbido dos refrigeradores (mais alto perto da parede fria), chiado ao abrir geladeira, névoa do hortifruti, sininho do forno com aviso "fornada quentinha" e alto-falante com três notas e um anúncio das ofertas do dia.
- Comer na despensa: mordidas crocantes.

**Regras (tudo no servidor):**

- Catálogo fixo de 25 produtos em 7 corredores (`PRODUCTS`); o servidor recalcula todos os preços, o cliente só pede os itens.
- Ofertas do dia: 4 produtos com 15 a 30% de desconto, iguais para todos e trocadas todo dia; até 3 unidades com desconto por morador por dia.
- Cartão Sorokiba: 1 ponto a cada R$ 10 pagos; 100 pontos valem R$ 10 de desconto numa compra de R$ 20 ou mais.
- Carrinho: até 12 produtos diferentes, 10 unidades de cada e 30 no total. Sem nada nas mãos você leva 4, com cesta 10 e com carrinho 30 (esse limite por transporte é só da tela; o servidor impõe os 30).
- O dinheiro das compras vai para o tesouro (`mercado` no extrato da Prefeitura).
- Despensa: até 20 de cada produto. Comer devolve de 1 a 6 de saúde pelo mesmo relógio do Hospital (`hospital.settle`), com 20 s entre mordidas, e não passa de 100.
- Carreira nova: **Operador de caixa** (`market_cashier`, Centro de Empregos, 50 XP, 3 vagas, três cargos: Operador de caixa, Operador sênior e Supervisor de loja; turno com leitura de preços, troco e embalagem).

Endpoints autenticados: `GET /api/sk2/market`, `POST /api/sk2/market/checkout` (`{items:[{id,qty}], redeem}`) e `POST /api/sk2/market/eat` (`{id}`). Tabelas: `sk2_market_pantry`, `sk2_market_card`, `sk2_market_deals` e `sk2_market_orders`, criadas em `market.init()`. `SK2_MARKET_TIME_SCALE=0.001` acelera a virada do dia das ofertas para teste.

Limitações atuais: como nos outros prédios, o servidor não sabe em que corredor ou caixa o jogador está; as consultas ao PostgreSQL do Mercado têm testes com banco simulado em memória, mas ainda não foram exercitadas contra um banco real; o estoque da loja é ilimitado.

## Testes

```sh
npm test
```

O cliente não cria contas locais quando a API está indisponível. Para testar explicitamente o modo offline de desenvolvimento, use `?devOffline=1` na URL ou defina `window.SK2_DEV_OFFLINE = true` antes de carregar a página.
