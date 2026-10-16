# Jack Fix It — Contexto do projeto

> Documento de referência para o Claude. Junto com o **Plano de Desenvolvimento do MVP** (escopo, modelo de dados e tasks diárias), ele descreve tudo o que é preciso saber para trabalhar no projeto. Última atualização: 16/10/2026.

---

## 1. O que é o produto

**Jack Fix It** é um marketplace de serviços domésticos nos EUA, no modelo "Uber de serviços". O cliente conta o que aconteceu em casa, a plataforma encontra um profissional verificado, o pagamento fica retido até o serviço ser confirmado, e os dois lados se avaliam.

- **Mercado inicial:** Sul da Flórida. Broward County no primeiro mês, depois Miami-Dade e Palm Beach. A arquitetura não pode fixar a região no código: áreas atendidas vêm do banco (região → cidades → ZIPs).
- **Posicionamento:** o cliente não precisa saber "quem chamar". Ele diz o que aconteceu e o Jack resolve. Não pode parecer um diretório de prestadores (Angi, Craigslist).
- **Diferencial frente aos concorrentes:**
  - Thumbtack vende o **lead**: o profissional paga mesmo sem fechar o serviço.
  - TaskRabbit vende a **tarefa**: forte em serviços pequenos e por hora.
  - Jack Fix It vende o **resultado**: não cobra por lead, ganha só quando o job acontece, verifica os profissionais, retém o pagamento e dá suporte humano (BDC).
- **BDC (equipe de atendimento):** pessoas que respondem novos pedidos em menos de 5 minutos, qualificam, fazem o match manual quando preciso e acompanham o job até o fim. É parte central do produto, não um extra.

## 2. Marca

- **Nome:** Jack Fix It. "Jack" é o concierge da casa e a cara da marca. A interface tem que ficar premium mesmo sem o personagem.
- **Cores:** azul-marinho profundo, laranja vivo e premium, branco e cinza claro nos fundos.
- **Estilo:** produto de tecnologia moderno e confiável. Nada de visual de construtora, de handyman antigo ou de cartoon. Muito espaço em branco, tipografia premium, cards arredondados, sombras sutis, ícones simples, pouca animação.
- **Tagline principal:** "Whatever happens at home, we fix it."
- **Apoio:** "Tell Jack. We'll take care of the rest." CTA principal: **"Tell Jack What Happened"**.

## 3. Modelo de negócio

- A plataforma fica com um **percentual de cada job concluído** (take rate). O deck usa 15% como exemplo; o valor final está **pendente**.
- Sem cobrança por lead e sem mensalidade para o profissional.
- O modelo de dados precisa suportar, por job: preço do cliente, repasse do profissional, taxa da plataforma, impostos, cobranças extras, descontos, reembolsos e ajustes.
- **Métricas que o sistema precisa medir desde o dia 1** (vêm do deck): tempo médio de primeira resposta, taxa de contato, lead → job, taxa de conclusão, nota média de clientes e de profissionais, taxa de disputa, recorrência, GMV e receita.
- **Critério para sair do MVP 1:** 100+ jobs concluídos, conclusão ≥ 90%, nota média ≥ 4,7, disputas abaixo de 2%.

## 4. Escopo do MVP

### Entra
- **App mobile único** (React Native) com dois modos: cliente e profissional.
- **Fluxo do pedido:** "o que aconteceu" (texto, fotos, vídeo, categoria opcional) → perguntas de contexto da categoria → local (ZIP, endereço, data e horário) → contato → confirmação "Jack is on it" com número do pedido (ex.: `JF-000124`).
- **Orçamento com preço fechado**, enviado pelo profissional (ou atribuído pelo BDC).
- **Pagamento protegido** com Stripe Connect (detalhes na seção 6).
- **Execução do job:** "a caminho", check-in com localização, fotos de antes e depois, conclusão.
- **Confirmação** pelo cliente ou automática em 48 h; **disputa** bloqueia o repasse.
- **Avaliações dos dois lados:** nota geral + comunicação, qualidade, pontualidade e custo-benefício, comentário e fotos opcionais.
- **Chat por job**, com telefone, e-mail e links ocultados no texto.
- **Onboarding do profissional:** perfil, categorias, ZIPs de atuação, documentos (ID, licença quando a categoria exige, seguro), conta Stripe Express, aprovação manual pelo admin.
- **Painel do BDC/admin (web):** fila de operações priorizada, aprovação de profissionais, match manual, ações financeiras com audit log, KPIs.
- **Landing page (web):** página de produto mobile-first com o pedido sem login e templates de SEO por serviço e cidade.
- **Idiomas:** inglês (principal) e espanhol. Arquitetura pronta para português.

### Categorias do lançamento (5)
House Cleaning, Handyman, Painting, Lawn & Landscaping, Moving & Assembly. Categorias são cadastradas no admin; AC, encanamento, elétrica, piscina e eletrodomésticos entram depois, só quando a verificação de licença estiver validada (na Flórida esses ofícios exigem licença).

### Fica fora (pós-MVP)
Rastreamento do profissional no mapa em tempo real, background check automático (Checkr), entrada por voz, classificação de pedidos com IA, análise de ligações do BDC com IA, telefonia integrada e mascaramento de número, pagamento por marcos, gorjeta, cupons, planos recorrentes, contas B2B, "My Home" (histórico da casa), apps separados para cliente e profissional.

## 5. Perfis e status

**Papéis:** `customer`, `pro`, `agent` (BDC), `admin`.

**Status que o cliente vê:**

| Status | Quando aparece |
|---|---|
| Request Received | Pedido criado |
| Reviewing | BDC classificando ou pedindo mais informação |
| Finding a Pro | Pedido enviado aos profissionais |
| Quote Ready | Há orçamento para aprovar |
| Scheduled | Pago e com data marcada |
| Professional On The Way | Profissional marcou "a caminho" |
| In Progress | Check-in feito |
| Waiting for Confirmation | Profissional concluiu; janela de 48 h aberta |
| Completed | Confirmado e repassado |
| Needs Attention | Problema aberto ou ação pendente do cliente |
| Cancelled | Cancelado por qualquer lado |

**Regras de negócio principais:**
- Só profissionais aprovados e com Stripe ativo (`payouts_enabled`) recebem pedidos.
- Cada pedido vai para até N profissionais da categoria e do ZIP (N configurável, padrão 5), ordenados por nota e tempo de resposta.
- Pedido sem categoria cai na fila do BDC, que classifica antes de distribuir.
- Orçamento expira em X horas (configurável).
- Sem confirmação nem disputa em 48 h após a conclusão, o job é confirmado automaticamente.
- Cancelamento grátis até 24 h antes; a regra depois disso está **pendente**.

**Fila do BDC (prioridade):** novos, urgentes, aguardando cliente, aguardando profissional, orçamento pronto, agendados hoje, problemas e disputas. Cada item mostra cliente, telefone, idioma, ZIP, resumo, categoria, urgência, mídia, status, agente responsável, criação, último contato e próxima ação.

## 6. Pagamentos

- **Stripe Connect** com contas **Express** para os profissionais, no modelo **separate charges and transfers**.
- O cliente paga no aceite do orçamento (PaymentIntent + Payment Sheet no app, com cartão, Apple Pay e Google Pay). O valor fica no saldo da plataforma.
- Depois da confirmação (ou de 48 h sem resposta), o worker cria a transferência para a conta do profissional: valor − take rate.
- Disputa aberta bloqueia o repasse até o admin decidir: liberar, reembolsar parcial ou reembolsar total.
- Pré-autorização de cartão **não** é usada, porque expira em poucos dias e o job pode ser agendado para semanas depois.
- Stripe em modo teste até o lançamento.

**Regras técnicas obrigatórias:**
- Webhooks com verificação de assinatura e processados uma única vez (tabela `webhook_events`).
- Idempotency key em toda cobrança, transferência e reembolso.
- Valores em centavos, calculados só no backend.
- Status do job muda apenas por transições válidas (máquina de estados no backend).

## 7. Linguagem jurídica (textos para o cliente)

Até haver aprovação jurídica, **não prometer**: seguro, garantia de mão de obra, escrow, reembolso garantido, licença em todas as categorias.

**Usar no lugar:** "Support when you need it", "Verified information where applicable", "Clear service records", "Secure payment experience".

Também não mostrar como funcional algo que não funciona (ex.: voz) e não usar depoimentos fictícios.

## 8. Stack

| Camada | Escolha |
|---|---|
| App mobile | React Native com Expo, Expo Router, TypeScript |
| UI do app | NativeWind (Tailwind) + componentes próprios + Reanimated |
| Dados no app | TanStack Query + Zustand |
| Backend | Python, FastAPI, SQLAlchemy 2 (async), Alembic, Pydantic v2 |
| Banco | PostgreSQL 16 (PostGIS opcional) |
| Fila e agendamento | Redis + ARQ (webhooks, notificações, auto-confirmação, expirações); Redis também faz o pub/sub do chat |
| Pagamentos | Stripe Connect (Express) + Payment Sheet |
| Arquivos | Cloudflare R2 ou Railway Buckets (ambos S3), sempre por URL pré-assinada |
| Autenticação | JWT próprio (access + refresh com rotação), senha com Argon2, OTP por SMS com Twilio Verify |
| Notificações | Expo Push, Resend (e-mail), Twilio (SMS) |
| Endereços | Google Places Autocomplete + Geocoding |
| Admin/BDC + landing | Next.js + shadcn/ui + TanStack Table (SSR na landing) |
| Admin interno rápido | SQLAdmin no FastAPI (aprovação de profissionais desde o Dia 7) |
| Idiomas | i18next (app e web) |
| Observabilidade | Sentry, UptimeRobot, logs em JSON |
| Analytics | PostHog |
| CI/CD | GitHub Actions; staging na `develop`, produção na `main` |

**Estrutura do monorepo:**
- `apps/mobile`: React Native (cliente + profissional)
- `apps/web`: Next.js (landing + painel admin/BDC)
- `apps/api`: FastAPI + worker ARQ
- `packages/shared`: tipos TypeScript gerados do OpenAPI da API

**Hospedagem — decisão pendente:**
- **Hostinger (VPS já existente):** Docker Compose com api, worker, postgres, redis, web e Caddy; backups com `pg_dump` diário para o R2. Custo quase zero, mas segurança e operação ficam com a gente.
- **Railway Pro:** serviços gerenciados, Postgres com backups agendados e PITR, rede privada, SOC 2 Type II, audit log, rollback de deploy. Custo mensal variável.
- Ambas nos EUA. O código deve funcionar nas duas: configuração só por variáveis de ambiente, armazenamento via API S3 genérica.

## 9. Modelo de dados (resumo)

O detalhe completo está no plano. Tabelas principais:

`users`, `pro_profiles`, `pro_documents`, `categories` (com `intake_questions` em JSON), `pro_categories`, `service_areas`, `pro_service_areas`, `addresses`, `service_requests` (também é o item da fila do BDC), `request_media` (foto e vídeo), `request_dispatches`, `quotes`, `jobs` (com valores congelados: `customer_price_cents`, `pro_payout_cents`, `platform_fee_cents`, `tax_cents`), `appointments`, `job_adjustments`, `job_events`, `job_photos`, `payments`, `transfers`, `refunds`, `disputes`, `messages`, `internal_notes`, `reviews`, `devices`, `webhook_events`, `audit_log`, `settings`.

**Eventos de analytics:** `request_started`, `request_submitted`, `photo_uploaded`, `category_selected`, `quote_viewed`, `quote_accepted`, `appointment_scheduled`, `payment_started`, `payment_completed`, `job_completed`, `review_submitted`.

## 10. Cronograma

- 20 dias úteis de 8 h (segunda a sexta), dentro de 30 dias corridos; a folga cobre a revisão das lojas.
- **Semana 1:** fundação (contas, design system, infra, auth, base do app).
- **Semana 2:** onboarding do profissional, Stripe Connect, pedido do cliente, distribuição, orçamentos, push.
- **Semana 3:** cobrança, execução do job, confirmação e repasse, chat, avaliações e disputas.
- **Semana 4:** painel do BDC, landing e pedido pela web, acabamento visual, QA e segurança, lançamento.
- As tasks de cada dia estão no Plano de Desenvolvimento do MVP.

## 11. Decisões

**Fechadas:**
- Marca Jack Fix It; azul-marinho, laranja, branco e cinza claro.
- App mobile em React Native com Stripe já no MVP.
- 5 categorias no lançamento.
- O README antigo (repositório Lovable) serve só como referência de conteúdo e UX.

**Pendentes:**
- Hospedagem: Hostinger ou Railway.
- Take rate final e quem absorve as taxas do Stripe.
- Regra de cancelamento e reembolso.
- Prazo da janela de garantia e o texto jurídico dela.
- Quem testa e aprova cada entrega semanal.
- Quem escreve os textos legais e o conteúdo da landing.
- Português no app ou só no atendimento do BDC.

## 12. Riscos principais

- **Aprovações externas:** conta Apple Developer de organização (exige D-U-N-S, pode levar semanas), Google Play e verificação do Stripe. Começar no Dia 1.
- **Revisão das lojas:** exigem exclusão de conta, termos e login de teste para o revisor.
- **Escopo crescendo** durante o mês.
- **Desintermediação** (cliente e profissional combinarem por fora). Mitigação: pagamento e garantia só pelo app, contatos ocultos no chat, reputação como incentivo.
- **Dev solo:** qualquer imprevisto atrasa direto; a prioridade é sempre o ciclo completo do job.

## 13. Glossário

- **BDC:** equipe de atendimento que responde leads, faz match e acompanha jobs.
- **Pro:** profissional que presta o serviço.
- **Request / pedido:** o que o cliente abre. **Quote / orçamento:** preço fechado do profissional. **Job:** orçamento aceito e pago.
- **Dispatch:** envio do pedido para profissionais elegíveis.
- **Take rate:** percentual da plataforma em cada job.
- **GMV:** valor total transacionado.
- **Repasse / transfer:** pagamento ao profissional pela conta Stripe Express.
- **PITR:** point-in-time recovery do Postgres.
