# BONGA — a place to play with your people

> A note on naming: the product is called **BONGA**. The GitHub repo, Render
> service, and folder are still named `squadup` for now since renaming
> infrastructure is a separate, optional step — see "Renaming the repo and
> live URL" near the end of this file if you want to do that too.

A real-time social gaming MVP: create a private room, invite friends, and play live
group and two-person games together. Built from the project proposal's Section 29
(MVP) scope.

## What's actually in this build

- **Landing → create/join room** with a shareable 5-character code and link
- **Live lobby** with real-time presence (join/leave, host badge, online dots)
- **Live voice chat** — a real WebRTC mesh call, works across Squad, Duo, and
  Casual Talks. Signaling rides the existing Socket.IO connection; audio flows
  directly between browsers using free public STUN servers. **Known
  limitation**: there's no TURN relay server, so some players on restrictive
  networks (school/office wifi, certain mobile carriers) may not be able to
  connect to specific other players. This is a real infrastructure gap, not a
  bug — a TURN server is a separate piece of paid infrastructure.
- **Casual Talks** — a third room mode alongside Squad/Duo with no scoring and
  no rounds. Just presence, reactions, and a shuffleable conversation-starter
  anyone can refresh.
- **Squad → "Who Knows Who?"** — vote for a person in the room, live results,
  points, suggested question categories (funny / savage / deep / random /
  hypothetical / friendship) + fully custom questions
- **Duo** (only unlocks with exactly 2 people in the room, and deliberately never
  labels your relationship) — **This or That / Match** with a live match score,
  and **Open Questions** (How Well Do You Know Me?, First Impression, Memory Test,
  Crush) with custom-question support
- **Reactions**, a typing indicator, and a 30–45s countdown per question
- **Basic safety**: leave room, report player (notifies host), host can remove a
  player or skip a question
- **Session recap**: leaderboard, most-voted highlight, duo match score, replay
- **Reconnection handling**: refreshing the page or a dropped mobile connection
  won't kick you out — you rejoin with your score intact for 2 minutes

## What's intentionally NOT in this build

Battle mode, Ask the Room as a separate mode, room history across sessions,
achievements, themes, accounts, and monetization are all Phase 2/3 in the original
proposal — building all of it wasn't realistic for a first pass. This version is
scoped to prove whether people actually want to play.

**Room data is in-memory only.** Rooms disappear when the server restarts
(including the free-tier "spin down after inactivity" behavior described below).
That's fine for testing with friends over a session; it is not a production data
layer for the rooms themselves.

**Usage analytics are separate from room data, and can persist.** Every meaningful
event (room created, player joined, question asked, session ended, report
submitted, etc.) is logged through `lib/analytics.js`. With zero setup it just
prints to the console. Set a `DATABASE_URL` environment variable pointing at any
free Postgres database and those events get written there instead — durable, and
queryable — so you can actually answer the questions from the proposal (activation,
replay rate, report rate, questions per session) instead of guessing. See "Collect
real usage data" below.

## Run it locally

```bash
npm install
npm start
```

Then open `http://localhost:3000`. Open it in a couple of browser tabs (or on your
phone via your computer's local IP) to simulate multiple players.

## Deploy it for free — step by step (Render)

I checked current options — **Render** is the best fit: a real free tier, no
credit card required, and it runs Node.js as a persistent process (required for
Socket.IO — platforms like Vercel/Netlify run serverless functions and **won't**
work for this app).

**The tradeoff:** Render's free web service spins down after 15 minutes with no
traffic, and takes about a minute to wake back up on the next visit. Totally fine
for testing with friends — just give it a moment to wake up if it's been idle.

### Steps

1. **Put this code in a GitHub repo.**
   - Go to [github.com/new](https://github.com/new), create a repo (e.g. `squadup`), keep it public or private.
   - From this project folder:
     ```bash
     git init
     git add .
     git commit -m "BONGA MVP"
     git branch -M main
     git remote add origin https://github.com/YOUR-USERNAME/squadup.git
     git push -u origin main
     ```

2. **Create a free Render account** at [render.com](https://render.com) (no card needed).

3. **New → Blueprint**, and point it at your GitHub repo. Render will detect the
   included `render.yaml` and configure everything automatically (it's already set
   to the free plan). Alternatively: **New → Web Service**, connect the repo, and
   set:
   - Build command: `npm install`
   - Start command: `node server.js`
   - Plan: **Free**

4. Click **Deploy**. After the build finishes you'll get a URL like
   `https://squadup-xxxx.onrender.com` — that's your live link.

5. Share that URL with friends. Anyone who opens it can create or join a room —
   no installs, no accounts.

### If you outgrow the free tier

If the 15-minute sleep becomes annoying (e.g. you want it always instantly ready),
**Koyeb** has a free tier with scale-to-zero but no hard monthly hour cap, and also
supports WebSockets — worth a look as a second option. Paid options ($5–7/mo) on
Render, Railway, or Fly.io remove the sleep entirely if this becomes a real project.

## Collect real usage data (recommended before your first real test)

Right now every event just prints to the server console, which disappears the
moment Render restarts the service. Five minutes of setup makes it durable and
queryable.

1. **Create a free Postgres database.** [Supabase](https://supabase.com) is a good
   default — free tier, no card required for the free project. (Neon is a solid
   alternative if you want a Postgres that's built to scale to zero without ever
   pausing.) Create a project, then grab the **connection string** (Supabase:
   Project Settings → Database → Connection string → URI, use the "Transaction"
   pooler string).

2. **Add it to Render.** In your Render web service → Environment → Add
   Environment Variable:
   - Key: `DATABASE_URL`
   - Value: the connection string from step 1

3. **Redeploy.** On startup you'll see `[analytics] Connected to Postgres. Events
   will be recorded.` in the Render logs instead of the console-only fallback
   message. Visiting `/health` on your deployed URL will show
   `"analyticsConnected": true`.

4. **Query it.** Every event lands in an `events` table:
   `event_type, room_code, payload (jsonb), created_at`. A few queries that map
   directly to the metrics discussed for this product:

   ```sql
   -- Activation: rooms created vs. rooms that got a second player
   select
     count(distinct room_code) filter (where event_type = 'room_created') as rooms_created,
     count(distinct room_code) filter (where event_type = 'player_joined') as rooms_with_invite_accepted
   from events;

   -- Questions per session (engagement)
   select room_code, count(*) as questions_asked
   from events
   where event_type in ('squad_question_asked', 'duo_question_asked')
   group by room_code
   order by questions_asked desc;

   -- Replay rate: how many sessions get "played again" vs just ended
   select
     count(*) filter (where event_type = 'session_replayed')::float
     / nullif(count(*) filter (where event_type = 'session_ended'), 0) as replay_rate;

   -- Report rate (safety signal — watch this alongside growth, not after it)
   select
     count(*) filter (where event_type = 'report_submitted')::float
     / nullif(count(distinct room_code), 0) as reports_per_room;

   -- Session length in minutes
   select room_code, (payload->>'durationMs')::float / 60000 as minutes
   from events
   where event_type = 'session_ended';
   ```

   Supabase's Table Editor also lets you browse `events` directly with no SQL if
   you just want to eyeball what's happening after your first test session.

## Testing with friends — a few tips

- Test on real phones over real mobile data, not just Wi-Fi on laptops — that's
  where the actual UX either holds up or doesn't.
- Start with 3–4 people for Squad before trying a bigger group.
- The host controls (⚙️ icon during a game) let you skip an awkward question or
  end the session early — worth knowing before you're mid-game.
- Because this is an MVP, the room disappears once everyone leaves or the server
  restarts. There's no way to return to a past room yet (that's Phase 2 — "Room
  History" in the original proposal).

## Safety notes (please read before sending this to a group)

This MVP ships with the **basic** safety layer only: report, block-by-leaving,
host kick, and host skip. It does **not** yet include the target-aware
throttling, silent opt-out, or age-aware content defaults discussed as
higher-priority follow-ups — the suggested question library already excludes any
late-night/explicit category by default, but a determined group can still write
unkind custom questions about each other. Keep initial testing to people you trust,
and use the host's skip/remove tools if a question or vote starts to feel like it's
targeting one person unkindly.

## Project structure

```
squadup/
├── server.js           # Express + Socket.IO server, all game logic, in-memory rooms
├── data/questions.js   # Suggested question library
├── public/
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js        # Client state machine + Socket.IO wiring
├── test/integration.js  # Automated end-to-end test (2 simulated players)
└── render.yaml           # One-click Render deploy config
```

## Running the test suite

```bash
npm install
node server.js &
node test/integration.js
```

This spins up two simulated players and walks through room creation, Squad voting,
Duo matching, reconnection, and safety reporting/kicking — 20 checks, all passing
as of this build.

## Renaming the repo and live URL (optional)

The product name is BONGA, but `render.yaml`'s service name was deliberately
**not** changed from `squadup` in this update. Here's why: Render ties an
existing deployed service to the name it was created with. If `render.yaml`'s
`name` field changes and gets synced, Render can interpret that as a *new*
service definition rather than a rename — leaving you with two services (one
live, one broken/duplicate) instead of one renamed one. Not worth the risk for
a cosmetic change.

If you want the live URL to say `bonga` instead of `squadup-4eth`, do it safely
via the dashboard instead:

1. Render dashboard → your service → **Settings**
2. Look for the service name field and change it there directly (this renames
   the existing service rather than creating a new one)
3. Your `.onrender.com` URL will update to match

Renaming the GitHub repo itself (`godfreygama/squadup` → `godfreygama/bonga`) is
independent and safe to do anytime via repo Settings → repository name — GitHub
automatically redirects the old URL, and Render's connection to it keeps working.
Neither of these is required for the brand to be correct where it matters: what
users actually see on the page.
