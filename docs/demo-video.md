# The end-to-end demo video

One continuous recording (plus a few cutaways) of the real product: a customer signs up and
requests a job; a pro signs up, uploads documents, is approved in the panel, sets up payouts and
quotes; the customer accepts and pays; the job runs, is completed and confirmed; the pro sees the
earnings; a second job has a problem that an admin resolves; the panel tour; the public site.

This page is the kit: the demo data, the pre-flight checklist, the storyboard and the recorded web
tour. Everything lives in `scripts/demo/`.

**Never record production data.** The seed refuses anything but a local `jackdemo*` database (and
a storage that is not on this machine, a deployed `APP_ENV`, a Stripe key that is not a TEST
key). The web tour's browser can reach `localhost`, `127.0.0.1` and one named staging host, and
no other: every connection it makes goes through a guard that refuses the rest. Stripe is always
in TEST mode.

## The cast

`seed_demo.py` makes these accounts. They are made-up people on `example.com`; every one of them
has the same demo password, generated when the accounts are made and kept in
`scripts/demo/.demo-password` (untracked, printed that once). Later seeds reuse the file. If it
is lost, the accounts keep their password: `--reset` makes a new one.

| Who   | Sign in             | Role                                                                                                                 |
| ----- | ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Avery | `admin@example.com` | Admin, panel in English                                                                                              |
| Riley | `agent@example.com` | BDC agent, panel in English; holds one urgent request                                                                |
| Jamie | `jamie@example.com` | Customer: a home address, a photo, a saved test card (Stripe TEST), one confirmed job, one open problem, two quotes  |
| Dan   | `dan@example.com`   | Pro, approved, payouts enabled: Handyman and Painting, with a month of jobs, earnings and reviews, and one job today |
| Maria | `maria@example.com` | Pro, **waiting for approval** with two image documents; the only pro of Moving & Assembly, so the video approves her |
| Sam   | `sam.lee@…`         | Background pros (Sam, Priya, Marcus) and 34 background customers: the history. Nobody needs to sign in as them       |

## What the seed makes

```sh
cd apps/api
uv run python ../../scripts/demo/seed_demo.py --reset   # drop, recreate, migrate, seed (about 2 minutes)
uv run python ../../scripts/demo/seed_demo.py           # again: "Already seeded", nothing changes
uv run python ../../scripts/demo/seed_demo.py --fresh   # one more request for the queue's New tab
```

It runs the real API in its own process and calls the same endpoints the apps and the panel
call, so every row is one the product would write: statuses move through the state machines
only, amounts are computed by the backend, staff actions write their audit rows. Stop the API and
the worker before `--reset` (it drops the database), and start them again after.

- **A 30-day history** (`--days`, `--seed`): about 100 requests, deterministic for a given seed
  and day. Roughly six in ten are booked and paid; the rest get a quote nobody accepts, are
  cancelled, or never get a quote. Completed jobs are confirmed by the customer or by the 48 h
  auto-confirm, a few percent have a problem that an admin resolved, most are reviewed. The
  services stamp everything "now"; the seed then dates each step where it belongs
  (`demo_seed/timeline.py`): time columns only, never a status.
- **The queue**: two fresh requests nobody holds (New), two urgent ones (the agent holds one), one
  waiting on its customer, requests waiting on pros and with quotes ready, jobs scheduled today,
  and two problems (Jamie's dispute and her ticket).
- **Jamie's jobs with Dan**: a confirmed one with both reviews, and one with a problem reported,
  two photos and Dan's reply, waiting for an admin. Both are paid with Stripe's test card through
  the TEST gateway when `STRIPE_SECRET_KEY` is a TEST key, so the panel's refund works.
- **Support**: three open tickets.

Things to know:

- **Seed right before a take.** The queue reads the clock: a request is New for
  `OPS_FIRST_CONTACT_SLA_MINUTES` (5), then Urgent; "scheduled today" means today.
  `--fresh` adds a new request without reseeding.
- **Stripe.** The history's payments are stand-ins (`demo_seed/stripe_standins.py`: ids that say
  `demo`; the seed calls Stripe for none of them, and Stripe knows none). Without a TEST key, or
  with `--stand-in-stripe`, Jamie's two jobs are stand-ins too, and the panel cannot refund the
  dispute.
- **A demo database is for the day it was seeded.** The running worker cannot act on a stand-in
  payment: a seeded job still waiting for its confirmation fails its transfer when the 48 h
  auto-confirm comes, and is retried at every sweep. Reseed rather than let one age.
- **Dan's payout account** is a stand-in id unless `DEMO_PRO_STRIPE_ACCOUNT` names a real TEST
  connected account (`acct_…`, onboarded once in TEST mode). With the stand-in, the pro's part of
  a dispute decided on camera fails to transfer (the refund still works), and Dan's Payouts
  screen cannot read the account.
- **No endpoint yet** for three things the history needs, so the seed uses the layer below: a
  customer's cancel before paying and the system's expiry go through `RequestStateMachine`
  itself, and the BDC's first contact is a time written on the request (#82 brings the actions).

## Start the stack

```sh
docker compose up -d                                   # Postgres and Redis
# A local S3 for documents and photos, for example:
docker run -d --name jack-demo-s3 -p 127.0.0.1:9000:9000 -v jack-demo-s3:/data \
  -e RUSTFS_ACCESS_KEY=<any> -e RUSTFS_SECRET_KEY=<any> -e RUSTFS_VOLUMES=/data rustfs/rustfs:latest
```

`apps/api/.env` (untracked), on top of `.env.example`:

| Variable                                                 | For the demo                                                                              |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                           | `postgresql://jack:jack@127.0.0.1:5432/jackdemo` (local, the name starts with `jackdemo`) |
| `JWT_SECRET`                                             | any long random value                                                                     |
| `S3_ENDPOINT_URL`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, …    | the local S3 above (the seed refuses one elsewhere, and creates the bucket when missing)  |
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`            | TEST keys (`sk_test_…`, `pk_test_…`)                                                      |
| `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET` | the signing secret `stripe listen` prints (below), in both                                |
| `PUBLIC_API_URL`                                         | where the phone reaches the API (Stripe's onboarding returns to it)                       |
| `MAPBOX_ACCESS_TOKEN`                                    | the route and the live map                                                                |

`apps/web/.env.local` (untracked), from `apps/web/.env.example`, with
`API_INTERNAL_URL=http://127.0.0.1:8000`: the panel's server reads it on every request, so it must
be set where `start` runs, not only for `build`.

Then, each in its own terminal:

```sh
cd apps/api && uv run python ../../scripts/demo/seed_demo.py --reset
cd apps/api && uv run python -m app.serve
cd apps/api && uv run arq app.worker.WorkerSettings --custom-log-dict app.observability.WORKER_LOG_CONFIG
stripe listen --forward-to localhost:8000/v1/webhooks/stripe \
  --forward-connect-to localhost:8000/v1/webhooks/stripe/connect
pnpm --filter @jack/web build && pnpm --filter @jack/web start
# The app: the dev client on the emulator, reaching the API and the storage on this machine
adb reverse tcp:8000 tcp:8000 && adb reverse tcp:9000 tcp:9000
EXPO_PUBLIC_API_URL=http://127.0.0.1:8000 EXPO_PUBLIC_PRO_LOCATION_SHARING=on \
  pnpm --filter @jack/mobile exec expo start --dev-client
```

Start the API and the worker from the same `.env`: the pre-flight proves the API is on the demo
database (the demo accounts sign in), but of the worker only that one is listening on the same
Redis. `adb reverse` lets the emulator use the same `127.0.0.1` addresses as this machine, so the
photo and document links the API signs for the local storage open in the app too.

Record the web app from a production build (`build` + `start`), not `next dev`: the dev overlay
would be in the shot.

## Pre-flight

```sh
cd apps/api && uv run python ../../scripts/demo/pre-flight.py [--api URL] [--web URL]
```

A green/red checklist; exit 0 when nothing is red. It never prints a key, a token or a password.

| Line                                 | Green means                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Demo database, Demo data             | local `jackdemo*`, seeded                                                                                           |
| Open dispute                         | Jamie's dispute is open and its payment is a Stripe TEST one (refundable)                                           |
| Queue, New tab                       | a fresh request is still New (yellow: run `--fresh`)                                                                |
| Push                                 | no device is registered, so no push leaves                                                                          |
| API, API dependencies                | the API answers, Postgres and Redis ready                                                                           |
| Admin, Agent, Jamie, Dan, Maria      | each signs in to the running API with the demo password; staff in English; Dan approved with payouts, Maria pending |
| Demo address, Categories             | Jamie's ZIP is served; the five launch categories exist                                                             |
| Worker                               | a worker on the API's Redis took a `ping` job (it cannot tell which database that worker writes)                    |
| Stripe keys, webhook secrets         | TEST keys that Stripe accepts; the signing secrets are set                                                          |
| Mapbox token (API), Storage, Web app | the route can be computed, the bucket answers, the panel and the landing answer                                     |

By eye, before recording: the emulator in English at font scale 1.0; the dev client's Tools gear
hidden; `EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN` in the dev build and `EXPO_PUBLIC_PRO_LOCATION_SHARING=on`;
no personal data on screen (use the demo accounts only); the emulator is one slot, so record the
customer's and the pro's scenes one after the other, signing out and in.

## Storyboard

About 8 to 10 minutes; each scene short. "Web" scenes are recorded by the web tour (next
section); the others on the emulator (Pixel 8: crop the 132 px status band).

| #   | Scene                                                                                       | Where | Account                     | Ends on                                                    | Seconds |
| --- | ------------------------------------------------------------------------------------------- | ----- | --------------------------- | ---------------------------------------------------------- | ------- |
| 1   | Public site: landing, `/app`, `/for-pros`                                                   | Web   | none                        | each page's hero, then a scroll                            | 20      |
| 2   | Customer signs up; the ID card builds step by step                                          | App   | a new customer              | "Here's your ID", then the profile card                    | 25      |
| 3   | Customer requests a job: **Moving & Assembly**, questions, photos, the Home address, review | App   | the new customer (or Jamie) | "Jack is finding a pro"                                    | 40      |
| 4   | Pro signs up, uploads documents                                                             | App   | a new pro (or Maria)        | "Waiting for approval"                                     | 40      |
| 5   | Panel: the queue shows the request; the pros page approves the pro                          | Web   | admin                       | the request held ("You hold this request"); badge Approved | 40      |
| 6   | Pro: payout setup (Stripe test onboarding), opportunities, a quote                          | App   | Maria (or the new pro)      | the quote sent                                             | 40      |
| 7   | Customer compares quotes and pays with the test card                                        | App   | the customer                | the job booked                                             | 40      |
| 8   | The job: On my way (live map, arrival code), arrival, photos, Job's done                    | App   | pro, then customer          | "Waiting for confirmation"                                 | 60      |
| 9   | Customer confirms, rates. Tips: pending #273. Receipt: pending #62                          | App   | the customer                | the rating sent                                            | 30      |
| 10  | Pro earnings                                                                                | App   | Dan                         | a month of paid jobs                                       | 15      |
| 11  | A cancellation after On my way, with the fee and the refund: pending #69                    | App   | the customer                | (recorded when #69 ships)                                  | 20      |
| 12  | A problem: the customer reports it; the pro replies                                         | App   | Jamie, then Dan             | Jamie's open problem (seeded, with Dan's reply)            | 30      |
| 13  | Panel: disputes, the detail, resolve with a partial                                         | Web   | admin                       | the dispute resolved ("Split")                             | 45      |
| 14  | Panel tour: KPIs and charts, support tickets, queue tabs                                    | Web   | admin                       | the KPI chart, read by keyboard                            | 45      |
| 15  | Closing: the landing hero                                                                   | Web   | none                        | the hero, cursor off the frame                             | 5       |

Notes for the takes:

- **Scene 3 uses Moving & Assembly on purpose.** Only Maria offers it, so the request waits in the
  queue's New tab (scene 5) and reaches her once she is approved and her payouts are on
  (scene 6). A Handyman or Painting request goes to Dan and Sam at once.
- Scenes 2 and 4 can be skipped by signing in as Jamie and Maria: the seed leaves both where
  those scenes end.
- Scene 6 needs Stripe Connect in TEST mode on the platform account, and `stripe listen`
  forwarding the Connect events.
- Scene 7 has a fallback: Jamie's seeded request with two quotes (Dan's and Sam's).
- Scenes that depend on work not shipped yet are marked "pending #N" and recorded when it ships;
  the agent actions (#82) and the web request flow (#86) will add panel and site shots.

## The web tour

`web-tour.mjs` signs in to the panel as the demo admin and walks scenes 1, 5, 13, 14 and 15 in a
headless browser at 1280x720, with a drawn cursor and deliberate pacing. It records one WebM per
scene, a still per beat, and a numbered scene list (`scenes.md`, `scenes.json`) with each scene's
seconds, failures, console errors, HTTP errors and any other host the page asked for.

```sh
cd scripts/demo
pnpm install --ignore-workspace        # once: playwright-core, pinned, outside the workspace
node web-tour.mjs --base http://localhost:3000 --out ./tour [--scenes queue,pros] [--headed]
```

It drives the installed Edge (`DEMO_BROWSER_CHANNEL`, default `msedge`; `chrome` works too): no
browser is downloaded. The demo password comes from `.demo-password`
(`DEMO_STAFF_PASSWORD_FILE`); it is filled in, never typed into a log. Other settings:
`DEMO_ADMIN_EMAIL`, `DEMO_WAITING_PRO` (Maria), `DEMO_DISPUTE_CODE` (default: the first open
dispute), `DEMO_PARTIAL_RELEASE` (250.00), `DEMO_TIME_ZONE` (America/New_York),
`DEMO_STAGING_HOST`, and `DEMO_STAGING_ALLOW_PRIVATE=1` when the staging host is on a private
network.

**The tour writes**: it takes a request, approves documents and the pro, moves a ticket and
resolves the dispute. Run `seed_demo.py --reset` before each take. On used data a scene with
nothing left to act on ends early (a `nothing-left` still), and the run still exits 0.

| #   | Scene    | Storyboard | What happens                                                                                                         | Seconds |
| --- | -------- | ---------- | -------------------------------------------------------------------------------------------------------------------- | ------- |
| 01  | login    | 5          | `/admin/login`: the email typed, the password filled, the admin home                                                 | 6       |
| 02  | queue    | 5, 14      | The tabs (Urgent, Waiting on customer, Scheduled today, Problems, New); a request nobody holds; "Take this request"  | 21      |
| 03  | pros     | 5          | Maria's card; a document opened in place (an image); each document approved; "Approve pro", "Yes, approve"           | 20      |
| 04  | support  | 14         | The first open ticket; "In progress"                                                                                 | 7       |
| 05  | kpis     | 14         | Last 7, 90 and 30 days; the pointer swept across the day chart; the chart read with the arrow keys                   | 18      |
| 06  | disputes | 13         | The open dispute; both sides, photos, money; a partial with an amount and a note; the code typed to confirm; "Split" | 32      |
| 07  | site     | 1          | `/`, `/app`, `/for-pros`: hero, an eased scroll down, back to the top                                                | 24      |
| 08  | site-es  | 1 (ES)     | `/es`, `/es/app`, `/es/for-pros`: the heroes                                                                         | 9       |
| 09  | closing  | 15         | `/` with the cursor off the frame, 5 s                                                                               | 6       |

The host guard (`tour-guard.mjs`): the browser is launched behind a small proxy the script runs,
loopback included, and the proxy connects to the allowed hosts only. A Playwright route could not
do this: it sees the first request of a redirect chain and not the hops after it, so an allowed
page answering 307 could forward a form to any host. At the proxy every connection is asked for
by name first: each hop of a redirect, a subresource, a frame, a fetch, a websocket. A refused
host gets no connection at all. A name is not an address, so no resolver decides where an allowed
name goes: `localhost` connects to 127.0.0.1 or ::1, from a table, whatever a hosts file says.
`DEMO_STAGING_HOST` is resolved once, before the tour starts. Every address it has is checked, and
the tour stops when one is link-local or cloud metadata (169.254.0.0/16, `fd00:ec2::254`), not
unicast, or loopback or private (allowed by `DEMO_STAGING_ALLOW_PRIVATE=1`). Its connections then
go to those addresses only: a later answer (DNS rebinding) is never asked for. What goes around a proxy is closed too: WebRTC sends no UDP (a
launch switch, and every frame of a scene loses the WebRTC constructors), and the guard's own
requests ignore Node's proxy settings (`NODE_USE_ENV_PROXY`, `HTTP_PROXY`). A broken answer from
an allowed server is a 502 for that request, never a crash. `scenes.md` lists the other hosts a
scene's pages asked for (all refused); `scenes.json` also lists everything the guard refused
during the scene (`guardRefused`), Edge's own background calls included (they are refused too). A
scene whose page would have left fails. The guard has its own tests in a real browser
(`pnpm test` in `scripts/demo`, also run by CI).

Cursor and recording:

- A headless recording has no OS cursor. An init script draws an arrow that follows Playwright's
  mouse and a green ring on each press; it keeps its place across navigations and puts itself
  back if React replaces the body. It is `aria-hidden` and takes no pointer events.
- Moves are slow on purpose: a glide of 28 steps to the element, a press held 90 ms so the ring
  shows, typing at 45 to 110 ms a key, eased scrolls, and pauses of 0.5 to 2.5 s.
- A document opens in a new tab in the product. A recording has no tab bar, so the tour opens the
  file in the same page and goes back. Headless Edge downloads a PDF instead of showing it: that
  is why the seed's documents are images.
- The panel reads the staff member's `locale` (the seed sets `en`); the tour sets the browser to
  `en-US` and `America/New_York`, or times would show the recording machine's zone.
- The dispute's refund is a real Stripe TEST call: the page says "Resolving…" for a few seconds,
  and the scene waits for the decision to land.
