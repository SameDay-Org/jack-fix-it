# Jack Fix It — Plano de Desenvolvimento do MVP

> - Versão em Markdown do PDF `docs/Jack Fix It — Plano de Desenvolvimento do MVP (2).pdf` (15/10/2026, @cesar), que continua em `docs/` como original.
> - Hospedagem: **Railway Pro**, decidida em 2026-10-16 ([ADR 0001](adr/0001-hosting-railway.md)). Staging na `develop`, produção na `main`. Este arquivo já aplica a decisão; as opções Hostinger/VPS/Caddy foram removidas.
> - IDs de task: `D<dia>.<item>`, na ordem dos itens de cada dia (ex.: `D8.2` = Dia 8, item 2). Os IDs são estáveis: nunca renumerar nem reutilizar; uma task removida fica no lugar, marcada como removida.
> - `[x]` = task concluída. Ao lado de cada task, as issues do GitHub que a cobrem.
> - Status que o cliente vê e termos do projeto: [glossary.md](glossary.md). Contexto do produto: [jack-fix-it-contexto.md](jack-fix-it-contexto.md).

## Visão geral

O MVP do Jack Fix It é um marketplace de serviços domésticos para o Sul da Flórida no modelo "Uber de serviços": o cliente pede, um profissional verificado executa e a plataforma segura o pagamento até o serviço ser confirmado. O desenvolvimento cabe em 20 dias úteis de 8 h, dentro do limite de 30 dias, e o restante fica como folga para a revisão das lojas.

**Objetivo do MVP:** validar o modelo com jobs reais. O deck define a saída do MVP 1 com 100+ jobs concluídos, conclusão ≥ 90%, nota média ≥ 4,7 e disputas abaixo de 2%, então o sistema mede isso desde o primeiro dia.

O que o produto precisa entregar:

- **Para o cliente:** profissional verificado, preço fechado antes do serviço, pagamento protegido e suporte se algo der errado.
- **Para o profissional:** nada de pagar por lead; ele recebe só quando o job acontece, com clientes vindo pela plataforma.
- **Para a operação (BDC):** um painel para responder leads em menos de 5 minutos, fazer o match e acompanhar cada job até o fim.

**Premissas deste plano:** um desenvolvedor, dias úteis de segunda a sexta, marca e textos legais fornecidos pelos sócios. O plano conta só tempo de execução, sem custos.

**Decisões fechadas:** marca Jack Fix It; cores azul-marinho, laranja, branco e cinza claro; app mobile em React Native (cliente e profissional) com Stripe já no MVP; lançamento com as 5 categorias do deck. O README do repositório antigo (Lovable) serve só como referência de conteúdo e UX.

**Hospedagem (decidida em 2026-10-16):** Railway Pro, nos EUA. Ambientes staging (deploy da `develop`) e produção (deploy da `main`); serviços api, worker e web; Postgres com backups agendados e PITR; Redis; rede privada entre os serviços; "Wait for CI" para não publicar commit com CI vermelho. Detalhes em [ADR 0001](adr/0001-hosting-railway.md) e [railway.md](railway.md).

## Escopo do MVP

Entra o ciclo completo de um job: pedido → orçamento → pagamento retido → execução → confirmação → repasse → avaliação. Fica fora tudo que não é necessário para os primeiros 100 jobs.

### Dentro do MVP

| Módulo                 | O que entrega                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Autenticação           | Cadastro e login por e-mail e senha, verificação de telefone por SMS (OTP), recuperação de senha, exclusão de conta                                |
| App do cliente         | Escolher categoria, criar pedido com fotos e endereço, comparar orçamentos, pagar, acompanhar o job, chat, confirmar, avaliar, histórico           |
| App do profissional    | Onboarding, envio de documentos, conta de recebimento (Stripe), feed de pedidos, orçamento, agenda, status do job, fotos de antes e depois, ganhos |
| Pagamento protegido    | Cobrança no aceite do orçamento, valor retido na plataforma, repasse após confirmação, take rate configurável, reembolso e disputa                 |
| Confiança              | Selo de verificado, avaliações dos dois lados, perfil público do profissional, janela de garantia para abrir problema                              |
| Comunicação            | Chat por job, push, e-mail e SMS transacionais                                                                                                     |
| Painel admin/BDC (web) | Fila de leads com cronômetro, aprovação de profissionais, gestão de jobs, match manual, liberação e estorno, disputas, KPIs                        |
| Landing page           | Página de produto mobile-first com o fluxo "conte o que aconteceu", páginas de serviço para SEO e captura de UTM                                   |
| Idiomas                | Inglês e espanhol (português opcional)                                                                                                             |

### Categorias iniciais

Limpeza (house cleaning), Handyman (marido de aluguel), Pintura, Jardinagem e Montagem/Mudança, as 5 do deck. As categorias são cadastradas no admin, então AC, encanamento, elétrica, piscina e eletrodomésticos entram depois sem mexer no código; as que exigem licença na Flórida só abrem quando a verificação de licença estiver validada.

### Fora do MVP

- Rastreamento do profissional em tempo real no mapa (o MVP tem status "a caminho" e check-in com localização)
- Background check automático (Checkr): no MVP a verificação é manual pelo admin
- Análise de ligações com IA, CRM próprio, planos recorrentes, contas B2B
- Pagamento por marcos em jobs grandes, gorjeta, cupons e indicação
- Mascaramento de telefone e chamadas pelo app

## Perfis e fluxos principais

Cliente e profissional usam o mesmo app React Native, com o modo escolhido no cadastro; admin/BDC usa o painel web.

### Fluxo do cliente

1. Cria conta e verifica o telefone.
2. Conta o que aconteceu (texto, foto ou vídeo) ou escolhe uma categoria, responde perguntas de contexto e informa endereço e data.
3. Recebe orçamentos de profissionais verificados (ou um match feito pelo BDC) e compara preço, nota e data.
4. Aceita um orçamento e paga pelo app. O valor fica retido.
5. Acompanha o status: agendado, a caminho, em andamento, concluído.
6. Confirma a conclusão ou abre um problema dentro da janela de garantia.
7. Avalia o profissional.

### Fluxo do profissional

1. Cria conta e preenche perfil, categorias e área de atuação (ZIP codes).
2. Envia documento com foto, licença (quando a categoria exige) e seguro.
3. Conecta a conta de recebimento pelo onboarding do Stripe.
4. Aguarda a aprovação do admin e recebe o selo de verificado.
5. Vê pedidos compatíveis e envia orçamento com preço fechado, escopo e data.
6. No dia, marca "a caminho", faz check-in, envia fotos de antes e depois e conclui.
7. Recebe o repasse após a confirmação e avalia o cliente.

### Fluxo do admin/BDC

1. Novo lead (app ou landing) entra na fila com cronômetro; a meta de primeiro contato é menos de 5 minutos.
2. Qualifica o pedido e, se nenhum profissional responder, faz o match manual.
3. Aprova ou recusa profissionais depois de conferir os documentos.
4. Acompanha jobs, resolve disputas e libera ou estorna pagamentos.
5. Acompanha os KPIs no dashboard.

### Regras de negócio

- Só profissionais aprovados e com Stripe ativo veem pedidos.
- Cada pedido vai para até N profissionais da categoria e da área (N configurável, padrão 5).
- Orçamento expira se não for aceito em X horas (configurável).
- Se o cliente não confirmar nem abrir problema em 48 h após a conclusão, o job é confirmado automaticamente.
- Cancelamento grátis até 24 h antes; depois disso, a regra é definida pelos sócios.
- Telefones, e-mails e links escritos no chat são ocultados, para manter o pagamento dentro do app.

### Status que o cliente vê

As chaves de i18n de cada status estão em [glossary.md](glossary.md).

| Status                   | Quando aparece                                    |
| ------------------------ | ------------------------------------------------- |
| Request Received         | Pedido criado                                     |
| Reviewing                | BDC está classificando ou pedindo mais informação |
| Finding a Pro            | Pedido enviado aos profissionais                  |
| Quote Ready              | Há orçamento para aprovar                         |
| Scheduled                | Pago e com data marcada                           |
| Professional On The Way  | Profissional marcou "a caminho"                   |
| In Progress              | Check-in feito                                    |
| Waiting for Confirmation | Profissional concluiu; janela de 48 h aberta      |
| Completed                | Confirmado e repassado                            |
| Needs Attention          | Problema aberto ou ação pendente do cliente       |
| Cancelled                | Cancelado por qualquer lado                       |

## Landing page (página de produto)

A landing é uma página de produto mobile-first com um único trabalho: fazer o cliente abrir um pedido em cerca de 60 segundos. O conteúdo vem do README do repositório antigo (Lovable); a marca é Jack Fix It, em azul-marinho, laranja e branco.

### Estrutura da página

1. **Header:** logo, Serviços, Como funciona, Para profissionais, Entrar e o CTA "Tell Jack".
2. **Hero:** "Whatever happens at home, we fix it." com uma linha de apoio; CTA principal "Tell Jack What Happened" e secundário "Explore Services"; selos curtos de profissionais verificados, agendamento fácil, pagamento seguro e suporte real.
3. **"What's going on at home?":** o bloco principal. Campo de texto ("I need a ceiling fan installed…"), upload de foto e de vídeo; abre o fluxo de pedido sem exigir login.
4. **Como funciona:** Tell Jack → We find the right pro → Get it done → Support when you need it.
5. **Serviços:** grade de categorias para quem prefere navegar, sem dominar a página.
6. **Confiança:** não precisa saber para quem ligar, tudo organizado num lugar, pessoas reais quando precisar, histórico do serviço guardado.
7. **Avaliações:** só entram quando houver avaliações reais; nenhum depoimento inventado.
8. **Para profissionais:** sem pagar por lead, recebe quando o job acontece, link para o app.
9. **Rodapé:** Serviços, Para profissionais, Áreas atendidas, Ajuda, Termos, Privacidade, Contato.

### Fluxo de pedido pela web

1. **O que aconteceu:** texto, fotos e vídeo; categoria opcional.
2. **Perguntas de contexto** por categoria, cadastradas no admin. Exemplos: limpeza (quartos, banheiros, metragem, única ou recorrente), handyman (vários pequenos serviços num pedido só).
3. **Local:** ZIP, endereço, data e horário preferidos. ZIP fora da área vai para lista de espera.
4. **Contato:** nome, sobrenome, telefone, e-mail e forma preferida (texto, ligação ou e-mail).
5. **Confirmação:** "Jack is on it", com número do pedido (ex.: JF-000124) e convite para criar conta e acompanhar.

Pedido sem categoria cai na fila do BDC, que classifica antes de distribuir. Voz não aparece até funcionar: nada que não funciona é mostrado como se funcionasse.

### Regras de texto

Até haver aprovação jurídica, landing e app não prometem seguro, garantia de mão de obra, escrow, licença em todas as categorias nem reembolso garantido. O texto para o cliente usa formulações como "Support when you need it", "Verified information where applicable", "Clear service records" e "Secure payment experience". Neste doc, "pagamento protegido" e "garantia" são nomes internos do fluxo, não texto de marketing.

### SEO e áreas atendidas

- Template reutilizável por serviço (`/house-cleaning`, `/handyman`) e por cidade + serviço (`/fort-lauderdale/handyman`), gerado das categorias e áreas cadastradas, só para combinações ativas.
- Áreas vêm do banco (região → cidades → ZIPs), sem South Florida fixo no código.

### Eventos de analytics

`request_started`, `request_submitted`, `photo_uploaded`, `category_selected`, `quote_viewed`, `quote_accepted`, `appointment_scheduled`, `payment_started`, `payment_completed`, `job_completed`, `review_submitted`.

## Stack e arquitetura

A stack React Native + FastAPI + Postgres serve bem e não precisa trocar: FastAPI é rápido de escrever, tipado com Pydantic, e Python já é seu terreno. O que falta são as peças em volta: pagamentos, fila de tarefas, arquivos, notificações e um painel web.

### Arquitetura do MVP no Railway

App e web falam com a API por HTTPS no Railway; o web chama a API pela rede privada do projeto. O worker cuida do que é assíncrono. Postgres e Redis ficam na rede privada. Cartão, arquivos e mensagens ficam em serviços externos (Stripe, storage S3, Expo Push, Resend, Twilio). Serviços e variáveis em [railway.md](railway.md).

| Camada             | Escolha                                                         | Por quê                                                                          |
| ------------------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| App mobile         | React Native com Expo, Expo Router, TypeScript                  | Build e publicação nas lojas pelo EAS, push nativo, atualização OTA              |
| UI do app          | NativeWind (Tailwind) + componentes próprios + Reanimated       | Visual caprichado, rápido e fiel à marca                                         |
| Dados no app       | TanStack Query + Zustand                                        | Cache e refetch prontos; pouco estado global                                     |
| Backend            | FastAPI, SQLAlchemy 2 (async), Alembic, Pydantic v2             | Mantém a stack; migrations versionadas                                           |
| Banco              | PostgreSQL 16 (PostGIS opcional)                                | Relacional para dinheiro; PostGIS se a área de atuação virar raio em km          |
| Fila e agendamento | Redis + ARQ                                                     | Webhooks, notificações, auto-confirmação em 48 h, expiração de orçamentos        |
| Pagamentos         | Stripe Connect (contas Express) + Payment Sheet no app          | Retenção e repasse, KYC do profissional pronto, cartão nunca passa pelo servidor |
| Arquivos           | Cloudflare R2 ou Railway Buckets (ambos S3), URLs pré-assinadas | Fotos de pedido, antes e depois, documentos                                      |
| Autenticação       | JWT próprio (access + refresh) + Twilio Verify para OTP         | Sem dependência de terceiros no login; telefone verificado                       |
| Notificações       | Expo Push, Resend (e-mail), Twilio (SMS)                        | Avisos de pedido, orçamento, status e pagamento                                  |
| Endereços          | Google Places Autocomplete + Geocoding                          | Endereço validado e coordenadas para o match                                     |
| Admin + landing    | Next.js + shadcn/ui + TanStack Table                            | Um só projeto web para o BDC e a página de captação                              |
| Idiomas            | i18next (app e web)                                             | Inglês e espanhol desde o início                                                 |
| Observabilidade    | Sentry (app, API, web), UptimeRobot, logs JSON                  | Erros visíveis antes do usuário reclamar                                         |
| Infra              | Railway Pro (staging e produção) + GitHub Actions               | Deploy por push; staging e produção separados                                    |
| Backups            | Railway: backups agendados + PITR                               | Restauração testada                                                              |
| Analytics          | PostHog                                                         | Funil pedido → orçamento → pago → concluído                                      |

### Organização do código

Monorepo no GitHub da empresa:

- `apps/mobile`: React Native (cliente + profissional)
- `apps/web`: Next.js (landing + painel admin/BDC)
- `apps/api`: FastAPI + worker ARQ
- `packages/shared`: tipos TypeScript gerados do OpenAPI da API

Por que um app só para os dois lados: metade das telas é comum (login, chat, perfil, job) e publicar um app em vez de dois economiza dias de revisão nas lojas. Dá para separar depois, se o produto crescer.

## Modelo de dados

O banco gira em torno de três tabelas: o pedido (`service_requests`), o orçamento aceito que vira job (`jobs`) e o pagamento (`payments`). Todo valor é guardado em centavos (inteiro), em USD.

| Tabela               | Campos principais                                                                                                                                                                                                                                                                   | Observação                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `users`              | id, email, phone, password_hash, role (customer, pro, agent, admin), locale, status                                                                                                                                                                                                 | agent e admin só acessam o painel                      |
| `pro_profiles`       | user_id, bio, foto, verification_status, stripe_account_id, payouts_enabled, rating_avg, jobs_count                                                                                                                                                                                 | Só approved + payouts_enabled recebe pedidos           |
| `pro_documents`      | pro_id, tipo (id, license, insurance), file_key, status, validade                                                                                                                                                                                                                   | Revisados pelo admin                                   |
| `categories`         | slug, nomes (en, es, pt), ícone, requires_license, reference_price, intake_questions (JSON), active                                                                                                                                                                                 | Perguntas de contexto editáveis no admin               |
| `pro_categories`     | pro_id, category_id                                                                                                                                                                                                                                                                 | N:N                                                    |
| `service_areas`      | região, cidade, zip_code, active                                                                                                                                                                                                                                                    | Expansão sem mexer no código                           |
| `pro_service_areas`  | pro_id, service_area_id                                                                                                                                                                                                                                                             | Área de atuação do profissional                        |
| `addresses`          | user_id, linha, cidade, zip, lat, lng                                                                                                                                                                                                                                               | Endereço do serviço                                    |
| `service_requests`   | public_code (JF-000124), customer_id, category_id (opcional), address_id, descrição, respostas de contexto (JSON), urgência, data preferida, contato preferido, idioma, status, assigned_agent_id, next_action, first_contact_at, last_contact_at, origem (app, web, telefone), utm | Pedido do cliente; também é o item da fila do BDC      |
| `request_media`      | request_id, tipo (photo, video), file_key                                                                                                                                                                                                                                           | Fotos e vídeos do pedido                               |
| `request_dispatches` | request_id, pro_id, sent_at, seen_at                                                                                                                                                                                                                                                | Para quem o pedido foi enviado; mede tempo de resposta |
| `quotes`             | request_id, pro_id, amount_cents, escopo, duração, data proposta, expires_at, status                                                                                                                                                                                                | Preço fechado                                          |
| `jobs`               | request_id, quote_id, customer_id, pro_id, status, customer_price_cents, pro_payout_cents, platform_fee_cents, tax_cents, started_at, completed_at, confirmed_at                                                                                                                    | Valores congelados no pagamento                        |
| `appointments`       | job_id, arrival_start, arrival_end, status                                                                                                                                                                                                                                          | Separado do job para permitir reagendar                |
| `job_adjustments`    | job_id, tipo (charge, discount, refund), amount_cents, motivo                                                                                                                                                                                                                       | Cobranças extras e ajustes                             |
| `job_events`         | job_id, tipo, ator, lat, lng, created_at                                                                                                                                                                                                                                            | Histórico de status e check-in                         |
| `job_photos`         | job_id, tipo (before, after), file_key                                                                                                                                                                                                                                              | Prova do serviço                                       |
| `payments`           | job_id, stripe_payment_intent_id, amount_cents, status                                                                                                                                                                                                                              | Cobrança do cliente                                    |
| `transfers`          | job_id, stripe_transfer_id, amount_cents, status                                                                                                                                                                                                                                    | Repasse ao profissional                                |
| `refunds`            | payment_id, amount_cents, motivo, stripe_refund_id                                                                                                                                                                                                                                  | Total ou parcial                                       |
| `disputes`           | job_id, opened_by, motivo, fotos, status, resolução                                                                                                                                                                                                                                 | Resolvidas pelo admin                                  |
| `messages`           | thread (request ou job), sender_id, texto, redacted, read_at                                                                                                                                                                                                                        | Chat                                                   |
| `internal_notes`     | request_id ou job_id, author_id, texto                                                                                                                                                                                                                                              | Notas do BDC, nunca visíveis ao cliente                |
| `reviews`            | job_id, author_id, target_id, nota geral, comunicação, qualidade, pontualidade, custo-benefício, comentário, fotos                                                                                                                                                                  | Uma por lado em cada job                               |
| `devices`            | user_id, expo_push_token, plataforma                                                                                                                                                                                                                                                | Push                                                   |
| `webhook_events`     | stripe_event_id, tipo, processed_at                                                                                                                                                                                                                                                 | Idempotência dos webhooks                              |
| `audit_log`          | admin_id, ação, entidade, antes, depois                                                                                                                                                                                                                                             | Toda ação financeira do admin fica registrada          |
| `settings`           | chave, valor                                                                                                                                                                                                                                                                        | Take rate, janela de confirmação, N de envios          |

## Pagamento protegido e estados do job

O cliente paga no aceite do orçamento, o dinheiro fica no saldo da plataforma e o profissional só recebe depois da confirmação. O modelo é o separate charges and transfers do Stripe Connect: a cobrança é da plataforma e o repasse é uma transferência para a conta Express do profissional, já sem o take rate.

**Estados do job (do aceite ao repasse):** os estados internos e as transições válidas são definidos em D12.1 (#60). O diagrama original está no PDF.

Enquanto o cliente não confirma, o dinheiro fica parado no saldo da plataforma; uma disputa congela o repasse até o admin decidir.

**Por que não pré-autorizar o cartão:** a pré-autorização expira em poucos dias, e um job pode ser agendado para semanas depois. Cobrar e reter no saldo funciona para qualquer prazo.

### Passo a passo do dinheiro

1. Cliente aceita o orçamento → a API cria um PaymentIntent com o valor total.
2. O app abre o Payment Sheet do Stripe; os dados do cartão vão direto para o Stripe.
3. Webhook `payment_intent.succeeded` → o job passa para agendado.
4. Profissional conclui → o cliente tem 48 h para confirmar ou abrir problema.
5. Confirmado (ou 48 h sem ação) → o worker cria a transferência (valor − take rate) para a conta do profissional.
6. Problema aberto → o repasse fica bloqueado até o admin decidir: liberar, reembolsar parcial ou total.

### Regras técnicas obrigatórias

- Webhooks verificados por assinatura e processados uma única vez (`webhook_events`).
- Toda cobrança, transferência e reembolso usa idempotency key.
- Valores sempre calculados no backend, nunca recebidos do app.
- Status só muda por transições permitidas (máquina de estados no backend).
- Stripe em modo teste até o Dia 20; modo live só no lançamento.
- Antes do Dia 11, conferir na documentação do Stripe os prazos de retenção de saldo e as regras de reembolso para a conta da LLC — #57

## Semana 1 — Fundação (Dias 1 a 5)

Ao fim da semana, o usuário cria conta e faz login no app apontando para staging, com infra, CI/CD e design system prontos.

### Dia 1 — Kickoff e contas

- [ ] **D1.1** Kickoff com os sócios: validar este escopo, categorias, regra de cancelamento e take rate (1 h) — #13
- [ ] **D1.2** Criar as contas no nome da LLC: GitHub, Stripe (Connect), Expo/EAS, Apple Developer, Google Play Console, Cloudflare (R2 e DNS), Sentry, Twilio, Resend, Google Cloud (Places), PostHog — #14
- [x] **D1.3** Criar o monorepo com padrões (ESLint, Prettier, Ruff, pre-commit), README e convenção de commits — #15 (PR do esqueleto do monorepo)
- [ ] **D1.4** Registrar decisões de arquitetura (ADRs curtos) e o glossário de status do job — #17 _(parcial: ADRs 0000–0006 e docs/glossary.md com os status do cliente; estados internos em D12.1)_
- [ ] **D1.5** Montar o board de tasks (Linear ou GitHub Projects) com este cronograma — sem issue

Entrega: contas criadas, repositório no ar, board pronto.

### Dia 2 — Design

- [ ] **D2.1** Design system da marca: azul-marinho, laranja, branco e cinza claro, tipografia, espaçamentos, raios, ícones — #18
- [ ] **D2.2** Protótipo das telas-chave no Figma: boas-vindas, home do cliente, criar pedido, orçamentos, acompanhamento do job, feed do profissional, detalhe do job, perfil, avaliação — #19
- [ ] **D2.3** Definir estados vazios, de carregamento e de erro — #19
- [ ] **D2.4** Validar o protótipo com o Guilherme (30 min), que cuida da marca — #19

Entrega: protótipo navegável aprovado.

### Dia 3 — Infra e backend base

> Dia 3 foi renumerado ao aplicar o Railway (2026-10-16): o item "Se Hostinger" saiu antes de os IDs serem publicados. D3.1–D3.3 são os IDs estáveis.

- [ ] **D3.1** Railway: projeto com ambientes staging e produção, serviços api, worker e web, Postgres e Redis em rede privada, backups agendados e PITR ativados, teste de restauração (cerca de meio dia) — #22, #23 _(parcial: railway\*.json e docs/railway.md; provisionamento manual)_
- [ ] **D3.2** GitHub Actions: lint, testes e build; deploy pela integração com git do Railway (staging na `develop`, produção na `main`) — #21 _(parcial: CI pronto; deploy pelo Railway é configuração manual)_
- [x] **D3.3** Esqueleto do FastAPI: config por ambiente, SQLAlchemy async, Alembic, health check, tratamento de erros, Sentry, logs JSON — #20 (PR do esqueleto do monorepo)

Entrega: API de staging respondendo em HTTPS.

### Dia 4 — Modelo de dados e autenticação

- [ ] **D4.1** Migrations de usuários, perfis, categorias, endereços, pedidos, orçamentos, jobs e eventos — #24
- [ ] **D4.2** Cadastro e login (senha com Argon2), JWT access e refresh com rotação — #25
- [ ] **D4.3** Verificação de telefone por OTP (Twilio Verify) e recuperação de senha por e-mail — #26, #27
- [ ] **D4.4** Permissões por papel (cliente, profissional, admin) e rate limit nas rotas de autenticação — #28
- [ ] **D4.5** Testes de API da autenticação e seed das categorias — #29 (testes de autenticação nas issues #25–#28)

Entrega: autenticação completa e documentada no Swagger.

### Dia 5 — Base do app

- [ ] **D5.1** Projeto Expo com Expo Router, TypeScript, NativeWind, fontes e tema da marca — #30 _(parcial: Expo Router, TypeScript, NativeWind e tokens provisórios; fontes e tema final dependem de D2.1)_
- [ ] **D5.2** Componentes: botão, input, card, avatar, badge de status, bottom sheet, toast, skeleton — #31
- [ ] **D5.3** Telas de boas-vindas, escolha de perfil, cadastro, OTP e login integradas à API — #33
- [ ] **D5.4** Token em armazenamento seguro, refresh automático, cliente HTTP com tipos gerados do OpenAPI — #32 _(parcial: tipos gerados do OpenAPI em packages/shared com checagem no CI)_
- [ ] **D5.5** i18n inglês/espanhol e primeiro dev build no celular (EAS) — #34 _(parcial: i18next en/es com teste de paridade; sem dev build)_

Entrega: login real no app contra staging.

## Semana 2 — Profissional e pedidos (Dias 6 a 10)

Ao fim da semana, um cliente cria um pedido e recebe orçamentos de profissionais aprovados, de ponta a ponta em staging.

### Dia 6 — Onboarding do profissional

- [ ] **D6.1** API e telas de perfil: foto, bio, anos de experiência, categorias, ZIP codes de atuação — #36
- [ ] **D6.2** Upload por URL pré-assinada para o storage S3 (R2 ou Railway Buckets), com compressão da imagem no app — #35
- [ ] **D6.3** Envio de documentos: documento com foto, licença (se a categoria exigir) e seguro — #37
- [ ] **D6.4** Status de verificação visível no app: pendente, aprovado, recusado com motivo — #38

Entrega: profissional completa o cadastro e fica pendente.

### Dia 7 — Stripe Connect

- [ ] **D7.1** Criar conta Express e abrir o link de onboarding do Stripe a partir do app — #39
- [ ] **D7.2** Deep link de retorno e atualização do status pelo webhook `account.updated` — #39, #40
- [ ] **D7.3** Endpoint de webhook com verificação de assinatura e idempotência, base para os próximos dias — #40
- [ ] **D7.4** Aprovação de profissionais pelo SQLAdmin (painel interno automático do FastAPI), liberando o Dia 16 para a operação do BDC — #41
- [ ] **D7.5** Testar o fluxo com contas de teste do Stripe — #39

Entrega: profissional aprovado e apto a receber.

### Dia 8 — Pedido do cliente

- [ ] **D8.1** Home do cliente com o campo "What's going on at home?" em destaque e as categorias como opção secundária — #43
- [ ] **D8.2** Pedido em etapas: o que aconteceu (texto, fotos, vídeo, categoria opcional) → perguntas de contexto → local (ZIP, endereço com Google Places, data e horário) → revisão — #45, #42
- [ ] **D8.3** Perguntas de contexto lidas da categoria (JSON editável no admin), prontas para as 5 categorias do lançamento — #44
- [ ] **D8.4** Checagem de ZIP atendido (Broward primeiro) e lista de espera para quem está fora — #46
- [ ] **D8.5** Confirmação "Jack is on it" com número do pedido e lista "Meus pedidos" com os status do cliente — #47

Entrega: pedido criado com texto, mídia, perguntas de contexto e endereço.

### Dia 9 — Distribuição e orçamentos

- [ ] **D9.1** Distribuição: profissionais aprovados, da categoria, com o ZIP do pedido, ordenados por nota e tempo de resposta; envia para até N — #48
- [ ] **D9.2** Feed de oportunidades no app do profissional, com detalhe e fotos do pedido — #49
- [ ] **D9.3** Envio de orçamento: valor fechado, o que inclui, duração estimada, data e horário — #50
- [ ] **D9.4** Expiração de orçamentos e pedidos pelo worker, com alerta ao BDC quando ninguém responde — #51

Entrega: profissional recebe e responde pedidos.

### Dia 10 — Comparação, aceite e push

- [ ] **D10.1** Tela de orçamentos: comparar preço, nota, jobs feitos, selo e data — #52
- [ ] **D10.2** Perfil público do profissional (versão inicial) — #53
- [ ] **D10.3** Push com Expo: registro de token, envio pelo worker, deep link para a tela certa — #54
- [ ] **D10.4** Notificações de novo pedido (profissional), novo orçamento (cliente) e orçamento aceito (profissional) — #55
- [ ] **D10.5** Demo gravada da semana para os sócios — #56

Entrega: pedido → orçamento → aceite funcionando com push.

## Semana 3 — Pagamento, execução e confiança (Dias 11 a 15)

Ao fim da semana, um job completo roda com dinheiro de teste: pagamento retido, execução, confirmação, repasse e avaliação.

### Dia 11 — Cobrança

- [ ] **D11.1** PaymentIntent no aceite do orçamento, com valor e take rate calculados no backend — #58
- [ ] **D11.2** Payment Sheet do Stripe no app (cartão, Apple Pay, Google Pay) — #59
- [ ] **D11.3** Webhooks de pagamento aprovado e recusado, criando o job como agendado — #61
- [ ] **D11.4** Tela de recibo e e-mail de confirmação — #62
- [ ] **D11.5** Testar cartão recusado, 3D Secure e webhook duplicado — #61

Entrega: cliente paga e o job aparece agendado para os dois lados.

### Dia 12 — Execução do job

- [ ] **D12.1** Máquina de estados no backend, com transições válidas e histórico em `job_events` — #60
- [ ] **D12.2** App do profissional: agenda, "a caminho", check-in com localização e hora, fotos de antes, concluir com fotos de depois — #63
- [ ] **D12.3** App do cliente: linha do tempo do job atualizada por push e refetch — #64
- [ ] **D12.4** Notificação em cada mudança de status — #65

Entrega: job vai de agendado a concluído pelo profissional.

### Dia 13 — Confirmação, repasse e cancelamento

- [ ] **D13.1** Tela de confirmação do cliente: confirmar ou relatar problema com fotos — #66, #75
- [ ] **D13.2** Auto-confirmação em 48 h por tarefa agendada no worker — #67
- [ ] **D13.3** Transferência para a conta do profissional, com idempotência e registro em `transfers` — #68
- [ ] **D13.4** Cancelamento pelo cliente ou pelo profissional, com regra de reembolso — #69
- [ ] **D13.5** Tela de ganhos do profissional — #70

Entrega: dinheiro de teste chega à conta Express do profissional.

### Dia 14 — Chat

- [ ] **D14.1** Chat por pedido e por job: conversas, mensagens, envio de foto, não lidas — #71, #74
- [ ] **D14.2** Tempo real por WebSocket no FastAPI com Redis pub/sub, e push como reserva — #73
- [ ] **D14.3** Ocultar telefone, e-mail e links no texto e avisar o usuário — #72
- [ ] **D14.4** Push de nova mensagem com deep link — #74

Entrega: cliente e profissional conversam dentro do job.

### Dia 15 — Avaliações e disputas

- [ ] **D15.1** Avaliação dos dois lados após a confirmação: nota geral, comunicação, qualidade, pontualidade e custo-benefício, comentário e fotos opcionais, com lembrete por push — #77
- [ ] **D15.2** Média e contagem recalculadas; perfil público completo com selo, avaliações e jobs feitos — #78
- [ ] **D15.3** Abertura de disputa dentro da janela, bloqueando o repasse — #75
- [ ] **D15.4** Endpoints de resolução para o admin: liberar, reembolso parcial ou total — #76
- [ ] **D15.5** Teste ponta a ponta do ciclo completo em staging — #79

Entrega: ciclo inteiro do job validado.

## Semana 4 — Admin, landing, acabamento e lançamento (Dias 16 a 20)

Ao fim da semana, o MVP está em produção, nas lojas em teste fechado, e o BDC opera tudo pelo painel.

### Dia 16 — Painel do BDC e operação

- [ ] **D16.1** Next.js com login por papel (agent, admin) e layout com shadcn/ui — #80
- [ ] **D16.2** Fila de operações priorizada: novos, urgentes, aguardando cliente, aguardando profissional, orçamento pronto, agendados hoje, problemas e disputas — #81
- [ ] **D16.3** Card do pedido com cliente, telefone, idioma, ZIP, resumo, categoria, urgência, mídia, status, agente, criação, último contato e próxima ação — #81
- [ ] **D16.4** Ações do agente: classificar, pedir mais informação, atribuir profissional, mudar status, agendar follow-up e notas internas; ligar, SMS e e-mail por links `tel:`, `sms:` e `mailto:`, sem telefonia integrada — #82
- [ ] **D16.5** Ações financeiras (liberar, reembolsar, resolver disputa) com confirmação e audit log, e dashboard com os KPIs do deck — #83, #84

Entrega: o BDC opera a fila inteira pelo painel.

### Dia 17 — Landing e pedido pela web

- [ ] **D17.1** Landing em Next.js, renderizada no servidor, seguindo a seção de landing deste doc — #85
- [ ] **D17.2** Pedido pela web sem login, com o mesmo fluxo do app, criando o pedido na fila do BDC com UTM — #86
- [ ] **D17.3** Templates de página por serviço e por cidade + serviço, com metadados de SEO, só para as categorias ativas — #87
- [ ] **D17.4** Página "Para profissionais" com link para baixar o app — #88
- [ ] **D17.5** Eventos de analytics no PostHog, na landing e no app — #89

Entrega: tráfego pago já pode apontar para a landing.

### Dia 18 — Acabamento visual

- [ ] **D18.1** Revisão tela a tela contra o protótipo: espaçamento, tipografia, contraste — #90
- [ ] **D18.2** Skeletons, estados vazios ilustrados, mensagens de erro claras, microanimações — #90
- [ ] **D18.3** Ícone do app, splash screen, screenshots e textos das lojas — #91
- [ ] **D18.4** Templates de e-mail e SMS com a marca — #92
- [ ] **D18.5** Revisão das traduções em espanhol por um falante nativo — #93

Entrega: app com cara de produto pronto.

### Dia 19 — QA e segurança

- [ ] **D19.1** Roteiro de testes manuais de todos os fluxos em iOS e Android, em aparelho real — #94
- [ ] **D19.2** Testes automatizados das regras críticas: cálculo de valores, transições de status, webhooks, permissões — #95
- [ ] **D19.3** Revisão de segurança: rate limit, validação de entrada, arquivos só por URL assinada, segredos fora do repositório, CORS — #96
- [ ] **D19.4** Termos de uso, privacidade e contrato do profissional no app; exclusão de conta (exigida pela Apple) — #97
- [ ] **D19.5** Correção dos bugs encontrados — sem issue

Entrega: nenhum bug crítico aberto.

### Dia 20 — Lançamento

- [ ] **D20.1** Deploy em produção, migrations, seed de categorias e configurações — #98
- [ ] **D20.2** Stripe em modo live, webhooks de produção e um pagamento real de valor baixo com reembolso — #99
- [ ] **D20.3** Build de produção no EAS e envio para App Store (TestFlight) e Google Play (teste fechado) — #100
- [ ] **D20.4** Runbook: deploy, restaurar backup, reprocessar webhook, resolver disputa — #101
- [ ] **D20.5** Demo final para os sócios e treinamento do BDC no painel — #102

Entrega: MVP em produção.

## Folga até o dia 30

Os dias corridos restantes cobrem a revisão das lojas (a Apple pode pedir ajustes), correções do primeiro uso real e o cadastro dos primeiros profissionais.

## Como adiantar o prazo

- **Landing com o Guilherme:** ele cuida de marketing; se ele montar a landing a partir do README, o Dia 17 fica só com o pedido pela web e os templates de SEO.
- **Admin mínimo antes:** o SQLAdmin já aprova profissionais desde o Dia 7; usá-lo também para ver jobs e adiar essa tela no Next.js. Economiza cerca de meio dia.
- **Chat sem WebSocket:** polling curto + push. Economiza cerca de meio dia.
- **Menos Figma:** construir direto com o design system e revisar no app. Economiza meio dia, com algum risco de retrabalho.
- **Um idioma no lançamento:** inglês primeiro, espanhol na semana seguinte.

Com esses cortes, o MVP sai em cerca de 17 a 18 dias úteis.

## Definição de pronto

O MVP está pronto quando um cliente real contrata, paga e avalia um profissional real sem ajuda técnica, e o BDC opera tudo pelo painel.

## Critérios de aceite do lançamento

- [ ] Cliente cria pedido, recebe orçamento, paga, acompanha, confirma e avalia, em iOS e Android
- [ ] Profissional se cadastra, envia documentos, conecta o Stripe, é aprovado, orça, executa e recebe o repasse
- [ ] Pagamento fica retido até a confirmação, e a auto-confirmação em 48 h funciona
- [ ] Disputa bloqueia o repasse e o admin consegue reembolsar total ou parcialmente
- [ ] Push, e-mail e SMS chegam nos eventos principais
- [ ] Painel mostra a fila de leads com cronômetro e os KPIs do deck
- [ ] App em inglês e espanhol
- [ ] Nenhum erro crítico aberto no Sentry; backup diário rodando e restauração testada
- [ ] Termos, privacidade e exclusão de conta disponíveis
- [ ] App aprovado, ou em teste fechado, nas duas lojas

## Padrão de cada task

Uma task só fecha com código revisado, migration quando houver, teste das regras afetadas, deploy em staging e verificação no aparelho.

## Riscos, premissas e dependências

O maior risco ao prazo não é o código, e sim as aprovações externas (Apple, lojas e Stripe), por isso todas começam no Dia 1.

| Risco                                                           | Impacto no prazo          | Mitigação                                                                                                                                |
| --------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Conta Apple Developer como empresa exige D-U-N-S e pode demorar | Trava a publicação no iOS | Pedir no Dia 1; se atrasar, lançar Android primeiro e iOS assim que liberar                                                              |
| Revisão das lojas rejeita o app                                 | 1 a 5 dias                | Exclusão de conta, termos e login de teste para o revisor; usar a folga                                                                  |
| Verificação da conta Stripe da LLC                              | Bloqueia o modo live      | Abrir no Dia 1 com os dados da LLC                                                                                                       |
| Escopo cresce durante o mês                                     | Estoura os 30 dias        | Pedido novo vai para o roadmap; só entra trocando por algo do mesmo tamanho                                                              |
| Dev solo: doença ou imprevisto                                  | Atraso direto             | Folga de cerca de uma semana; prioridade é o ciclo do job                                                                                |
| Textos legais e marca atrasam                                   | Trava os Dias 19 e 20     | Pedir aos sócios até o Dia 10                                                                                                            |
| Desintermediação depois do primeiro job                         | Receita                   | Pagamento e garantia só pelo app, contatos ocultos no chat, reputação como incentivo                                                     |
| Serviço fora do ar (api, worker ou web)                         | Webhooks atrasados        | Stripe reenvia webhooks; alerta no UptimeRobot; healthchecks e rollback de deploy do Railway; configuração como código (`railway*.json`) |

## O que preciso dos sócios

- Contas criadas ou acesso concedido no nome da LLC (Dia 1) — #14
- Logo, cores e arquivos da marca (Dia 2) — #8
- Take rate, regra de cancelamento e prazo de garantia (Dia 1) — #2, #3, #4
- Lista de ZIP codes atendidos no lançamento (Dia 8) — #9
- Termos de uso, privacidade e contrato do profissional (Dia 10) — #10
- Uma pessoa do BDC para testar o painel (Dia 17) — #11
- Profissionais reais para teste beta (Dia 18) — #12

## Pós-MVP e pendências

Depois do lançamento, a prioridade é o que aumenta confiança e ticket médio, na ordem que o deck propõe.

| Fase               | Funcionalidades                                                                                                                                                                                                     | Issue |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| v1.1 (mês 2)       | Rastreamento do profissional no mapa, preço tabelado para limpeza (por quartos e banheiros), reagendamento, gorjeta                                                                                                 | #103  |
| v1.2 (meses 3 e 4) | Background check com Checkr, pagamento por marcos em jobs grandes, cupons e indicação, categorias de alto valor (HVAC, elétrica, encanamento, telhado)                                                              | #104  |
| v2 (meses 4 a 6)   | Classificação do pedido e entrada por voz com IA, análise das conversas do BDC, planos recorrentes, "My Home" (histórico da casa), contas B2B (property managers, hosts de Airbnb), apps separados se fizer sentido | #105  |

## Para decidir com os sócios antes do Dia 1

- [x] Hospedagem: **Railway Pro**, decidida em 2026-10-16 ([ADR 0001](adr/0001-hosting-railway.md)) — #1
- [ ] Take rate final e quem absorve as taxas do Stripe (cliente, profissional ou plataforma) — #2
- [ ] Regra de cancelamento e reembolso — #3
- [ ] Prazo da janela de garantia e texto jurídico aprovado para ela — #4
- [ ] Quem testa e aprova cada entrega semanal — #5
- [ ] Quem escreve os textos legais e o conteúdo da landing — #6
- [ ] Português entra no app ou só no atendimento do BDC? — #7
