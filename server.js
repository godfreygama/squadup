const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { customAlphabet } = require("nanoid");

const {
  squadCategoryMeta,
  duoCategoryMeta,
  getSquadQuestion,
  getDuoThisOrThat,
  getDuoOpen
} = require("./data/questions");
const {
  activityCatalog,
  getTruthPrompt,
  getHotSeatPrompt,
  getDarePrompt,
  getNeverHaveIEverPrompt,
  getWouldYouRatherPrompt
} = require("./lib/activities");
const { getCasualTopic } = require("./data/casualTopics");
const analytics = require("./lib/analytics");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (req, res) => res.json({ ok: true, rooms: rooms.size, analyticsConnected: !!process.env.DATABASE_URL }));

// ---- Room code generation (no ambiguous chars) ----
const genCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 5);

// ---- In-memory state ----
// rooms: Map<code, Room>
//
// GENERIC ACTIVITY ENGINE — replaces the old separate room.squad / room.duo
// game-state objects. Every game (Squad's "Who Knows Who?", Duo's Match and
// Open Question, and the new Truth/Hot Seat/Dare/etc.) runs through ONE round
// state machine. What a specific game IS lives in lib/activities.js as data
// (activityCatalog), not as bespoke server code.
//
// room.activity = {
//   status: 'idle' | 'asking' | 'awaiting-verification' | 'revealed',
//   round: null | Round,
//   timer, graceTimer: setTimeout handles,
//   spotlightOrder, spotlightPointer: rotation queue for Truth/Hot Seat/Dare targets,
//   judgeOrder, judgePointer, judgeToken: separate rotation queue for who judges Challenges,
//   seatHolder: token | null  (Hot Seat persists across several rounds, unlike everything else)
// }
//
// Round = {
//   id, activityId (key into activityCatalog), mode ('squad'|'duo'), responseMode,
//   text, a, b, fixedOptions,          // prompt content — shape depends on responseMode
//   askedBy (nickname),
//   targetToken, performerToken,       // who this round is about / who's performing
//   requiredResponders: Set<token>,
//   responses: Map<token, value>,      // value shape depends on responseMode
//   verdict: null|'passed'|'failed'    // challenge only
// }
//
// LEGACY COMPATIBILITY: the old squad:ask/squad:vote/duo:ask/duo:answer events
// and their squad:question/squad:results/duo:question/duo:results responses
// still work exactly as before — they're now thin adapters over the generic
// engine (see emitLegacyQuestionStart / emitLegacyProgress / emitLegacyResults).
// This means the currently-deployed client keeps working with zero changes.
// New activities are exposed only via the new activity:* events.
const rooms = new Map();
const REMOVAL_GRACE_MS = 2 * 60 * 1000;
const SQUAD_TIMER_MS = 30 * 1000;
const SQUAD_GRACE_MS = 6 * 1000;
const SQUAD_THRESHOLD_RATIO = 0.7;
const DUO_BACKSTOP_MS = 10 * 60 * 1000; // silent safety net, never shown as a countdown

const AVATAR_COLORS = ["#7C5CFF", "#FF5CA8", "#3DDC97", "#FFB020", "#4DA3FF", "#FF6B5C", "#C77CFF", "#5CE1E6"];

function pickColor(room) {
  const used = new Set([...room.players.values()].map(p => p.color));
  const free = AVATAR_COLORS.filter(c => !used.has(c));
  return free.length ? free[0] : AVATAR_COLORS[room.players.size % AVATAR_COLORS.length];
}

function publicRoom(room) {
  return {
    code: room.code,
    name: room.name,
    mode: room.mode,
    phase: room.phase,
    judgeToken: room.activity.judgeToken,
    casualTopic: room.casualTopic || null,
    voiceParticipants: [...(room.voiceParticipants || [])],
    players: [...room.players.values()]
      .filter(p => p.connected || Date.now() - (p.disconnectedAt || 0) < REMOVAL_GRACE_MS)
      .map(p => ({
        token: p.token,
        nickname: p.nickname,
        avatar: p.avatar,
        color: p.color,
        score: p.score,
        isHost: p.isHost,
        connected: p.connected
      }))
  };
}

function broadcastLobby(room) {
  io.to(room.code).emit("room:state", publicRoom(room));
}

function makeName() {
  const adjectives = ["Friday", "Late Night", "Golden", "Chaotic", "Cozy", "Wild", "Sunset", "Rooftop"];
  const nouns = ["Crew", "Night", "Circle", "Squad", "Hangout", "Gathering"];
  return `${adjectives[Math.floor(Math.random() * adjectives.length)]} ${nouns[Math.floor(Math.random() * nouns.length)]}`;
}

function clearTimer(t) {
  if (t) clearTimeout(t);
}

function freshActivityState() {
  return {
    status: "idle", round: null, timer: null, graceTimer: null,
    spotlightOrder: [], spotlightPointer: -1,
    judgeOrder: [], judgePointer: -1, judgeToken: null,
    seatHolder: null
  };
}

function clearActivityTimers(room) {
  clearTimer(room.activity.timer);
  clearTimer(room.activity.graceTimer);
  room.activity.timer = null;
  room.activity.graceTimer = null;
}

// ---------------- rotation queues ----------------

function refreshRotationOrder(room, key) {
  const connected = [...room.players.values()].filter(p => p.connected).map(p => p.token);
  const existing = room.activity[key].filter(t => connected.includes(t));
  const added = connected.filter(t => !existing.includes(t));
  room.activity[key] = [...existing, ...added];
}

function nextInRotation(room, orderKey, pointerKey, excludeToken) {
  refreshRotationOrder(room, orderKey);
  const order = room.activity[orderKey];
  if (!order.length) return null;
  for (let i = 0; i < order.length; i++) {
    room.activity[pointerKey] = (room.activity[pointerKey] + 1) % order.length;
    const candidate = order[room.activity[pointerKey]];
    if (candidate !== excludeToken) return candidate;
  }
  return order[room.activity[pointerKey]]; // everyone excluded (e.g. 1-player edge case) — fall back
}

function nextSpotlight(room, excludeToken) {
  return nextInRotation(room, "spotlightOrder", "spotlightPointer", excludeToken);
}

function nextJudge(room, excludeToken) {
  return nextInRotation(room, "judgeOrder", "judgePointer", excludeToken);
}

// ---------------- starting a round ----------------

function startRound(room, activityId, { source, category, text, a, b, askedByToken }) {
  const def = activityCatalog[activityId];
  if (!def) return null;
  const asker = room.players.get(askedByToken);
  if (!asker) return null;
  if (room.activity.status === "asking" || room.activity.status === "awaiting-verification") return null;

  const round = {
    id: `${Date.now()}`, activityId, mode: def.mode, responseMode: def.responseMode,
    askedBy: asker.nickname, responses: new Map(), startedAt: Date.now(), verdict: null
  };

  switch (activityId) {
    case "vote-person":
    case "most-likely-to": {
      round.text = source === "custom" ? (text || "").trim().slice(0, 200) : getSquadQuestion(category || "mixed").text;
      if (!round.text) return null;
      break;
    }
    case "match": {
      if (source === "custom") {
        const optA = (a || "").trim().slice(0, 60), optB = (b || "").trim().slice(0, 60);
        if (!optA || !optB) return null;
        round.a = optA; round.b = optB;
      } else {
        const q = getDuoThisOrThat(category || "mixed");
        round.a = q.a; round.b = q.b;
      }
      round.text = `${round.a} or ${round.b}`;
      break;
    }
    case "open-question": {
      round.text = source === "custom" ? (text || "").trim().slice(0, 200) : getDuoOpen(category || "how-well");
      if (!round.text) return null;
      break;
    }
    case "never-have-i-ever": {
      round.text = source === "custom" ? (text || "").trim().slice(0, 200) : getNeverHaveIEverPrompt();
      round.fixedOptions = ["Have", "Haven't"];
      break;
    }
    case "would-you-rather": {
      if (source === "custom") {
        const optA = (a || "").trim().slice(0, 60), optB = (b || "").trim().slice(0, 60);
        if (!optA || !optB) return null;
        round.a = optA; round.b = optB;
      } else {
        const q = getWouldYouRatherPrompt();
        round.a = q.a; round.b = q.b;
      }
      round.text = `Would you rather ${round.a} or ${round.b}?`;
      break;
    }
    case "truth": {
      round.targetToken = nextSpotlight(room, askedByToken);
      round.text = source === "custom" ? (text || "").trim().slice(0, 200) : getTruthPrompt();
      break;
    }
    case "hot-seat": {
      if (room.activity.seatHolder && room.players.has(room.activity.seatHolder)) {
        round.targetToken = room.activity.seatHolder;
      } else {
        round.targetToken = nextSpotlight(room, askedByToken);
        room.activity.seatHolder = round.targetToken;
      }
      round.text = source === "custom" ? (text || "").trim().slice(0, 200) : getHotSeatPrompt();
      break;
    }
    case "dare": {
      round.performerToken = nextSpotlight(room, askedByToken);
      if (!room.activity.judgeToken || !room.players.has(room.activity.judgeToken) || room.activity.judgeToken === round.performerToken) {
        room.activity.judgeToken = nextJudge(room, round.performerToken);
      }
      round.text = source === "custom" ? (text || "").trim().slice(0, 200) : getDarePrompt();
      break;
    }
    default:
      return null;
  }

  const allTokens = [...room.players.keys()];
  if (def.requiredResponders === "target-only") round.requiredResponders = new Set([round.targetToken]);
  else if (def.requiredResponders === "all-except-target") round.requiredResponders = new Set(allTokens.filter(t => t !== round.targetToken));
  else round.requiredResponders = new Set(allTokens);

  room.activity.round = round;
  room.activity.status = "asking";
  clearActivityTimers(room);
  if (def.responseMode === "poll" && def.mode === "squad") {
    room.activity.timer = setTimeout(() => resolveActivityRound(room), SQUAD_TIMER_MS);
  } else if (def.responseMode !== "challenge") {
    room.activity.timer = setTimeout(() => resolveActivityRound(room), DUO_BACKSTOP_MS);
  }
  // challenge: no timer — waits for the performer's self-report; the whole point
  // of a dare is that nothing happens until someone actually attempts it.

  emitActivityQuestion(io.to(room.code), room, round, def);
  emitLegacyQuestionStart(io.to(room.code), room, round);
  analytics.track("activity_asked", room.code, { activityId, source });
  return round;
}

function emitActivityQuestion(target, room, round, def) {
  target.emit("activity:question", {
    id: round.id, activityId: round.activityId, mode: round.mode, responseMode: round.responseMode,
    text: round.text, a: round.a, b: round.b, fixedOptions: round.fixedOptions,
    askedBy: round.askedBy, targetToken: round.targetToken || null, performerToken: round.performerToken || null,
    judgeToken: room.activity.judgeToken,
    timed: def.responseMode === "poll" && def.mode === "squad",
    durationMs: (def.responseMode === "poll" && def.mode === "squad") ? SQUAD_TIMER_MS : undefined,
    players: publicRoom(room).players
  });
}

function emitLegacyQuestionStart(target, room, round) {
  if (round.activityId === "vote-person") {
    target.emit("squad:question", {
      id: round.id, text: round.text, askedBy: round.askedBy, timed: true,
      durationMs: SQUAD_TIMER_MS, players: publicRoom(room).players
    });
  } else if (round.activityId === "match") {
    target.emit("duo:question", { id: round.id, kind: "match", text: round.text, a: round.a, b: round.b, askedBy: round.askedBy, timed: false });
  } else if (round.activityId === "open-question") {
    target.emit("duo:question", { id: round.id, kind: "open", text: round.text, askedBy: round.askedBy, timed: false });
  }
}

// ---------------- submitting a response ----------------

function submitResponse(room, token, roundId, value) {
  const act = room.activity;
  if (!act.round || act.round.id !== roundId || act.status !== "asking") return false;
  const round = act.round;
  const def = activityCatalog[round.activityId];
  if (!round.requiredResponders.has(token)) return false;
  if (round.responses.has(token) && def.responseMode !== "challenge") return false; // no changing your answer after submitting

  if (def.responseMode === "challenge") {
    round.responses.set(token, true);
    act.status = "awaiting-verification";
    clearActivityTimers(room);
    io.to(room.code).emit("activity:awaiting-verification", {
      roundId: round.id, judgeToken: act.judgeToken, performerToken: round.performerToken
    });
    return true;
  }

  round.responses.set(token, value);
  const total = round.requiredResponders.size;
  const answered = round.responses.size;
  io.to(room.code).emit("activity:progress", { roundId: round.id, answered, total, answeredTokens: [...round.responses.keys()] });
  emitLegacyProgress(room, round, answered, total);

  if (answered >= total) {
    clearActivityTimers(room);
    resolveActivityRound(room);
  } else if (def.responseMode === "poll" && def.mode === "squad") {
    const threshold = Math.max(2, Math.ceil(total * SQUAD_THRESHOLD_RATIO));
    if (answered >= threshold && !act.graceTimer) {
      clearTimer(act.timer);
      act.timer = null;
      act.graceTimer = setTimeout(() => { act.graceTimer = null; resolveActivityRound(room); }, SQUAD_GRACE_MS);
    }
  }
  return true;
}

function emitLegacyProgress(room, round, answered, total) {
  if (round.activityId === "vote-person") {
    io.to(room.code).emit("squad:progress", { answered, total, answeredTokens: [...round.responses.keys()] });
  } else if (round.activityId === "match" || round.activityId === "open-question") {
    io.to(room.code).emit("duo:progress", { answered, total, answeredTokens: [...round.responses.keys()] });
  }
}

function submitVerdict(room, judgeToken, roundId, verdict) {
  const act = room.activity;
  if (!act.round || act.round.id !== roundId || act.status !== "awaiting-verification") return false;
  if (act.judgeToken !== judgeToken) return false;
  if (verdict !== "passed" && verdict !== "failed") return false;
  const performerToken = act.round.performerToken;
  resolveActivityRound(room, verdict);
  room.activity.judgeToken = nextJudge(room, performerToken);
  return true;
}

// ---------------- resolving a round ----------------

function resolvePollTally(room, round, def) {
  const tally = new Map();
  for (const answer of round.responses.values()) tally.set(answer, (tally.get(answer) || 0) + 1);

  if (def.scoring.participation) {
    for (const token of round.responses.keys()) {
      const p = room.players.get(token);
      if (p) p.score += def.scoring.participation;
    }
  }

  let matched = null;
  if (def.scoring.bothMatched && round.mode === "duo") {
    const tokens = [...round.requiredResponders];
    const [t1, t2] = tokens;
    const a1 = round.responses.get(t1), a2 = round.responses.get(t2);
    matched = a1 !== undefined && a1 === a2;
    if (matched) {
      [t1, t2].forEach(t => { const p = room.players.get(t); if (p) p.score += def.scoring.bothMatched; });
    }
  } else if (def.scoring.topVoted && def.options === "players") {
    const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1]);
    if (sorted.length) {
      const topCount = sorted[0][1];
      sorted.filter(([, c]) => c === topCount).forEach(([token]) => {
        const p = room.players.get(token);
        if (p) { p.score += def.scoring.topVoted; p.votesWon = (p.votesWon || 0) + 1; }
      });
    }
  }

  return { kind: "poll", tally: [...tally.entries()], matched };
}

function resolveFreeAnswer(room, round, def) {
  if (def.scoring && def.scoring.participation) {
    for (const token of round.responses.keys()) {
      const p = room.players.get(token);
      if (p) p.score += def.scoring.participation;
    }
  }
  return { kind: "freeAnswer", responses: [...round.responses.entries()] };
}

function resolveChallenge(room, round, def, verdict) {
  const performer = room.players.get(round.performerToken);
  if (performer) {
    if (verdict === "passed" && def.scoring.passed) performer.score += def.scoring.passed;
    if (verdict === "failed" && def.scoring.failed) performer.score += def.scoring.failed;
  }
  return { kind: "challenge", verdict, performerToken: round.performerToken };
}

function topLabel(resultPayload, room) {
  if (!resultPayload.tally || !resultPayload.tally.length) return null;
  const sorted = [...resultPayload.tally].sort((a, b) => b[1] - a[1]);
  const p = room.players.get(sorted[0][0]);
  return p ? p.nickname : null;
}

function resolveActivityRound(room, verdict) {
  const act = room.activity;
  const round = act.round;
  if (!round) return;
  const def = activityCatalog[round.activityId];

  let resultPayload;
  if (def.responseMode === "poll") resultPayload = resolvePollTally(room, round, def);
  else if (def.responseMode === "freeAnswer") resultPayload = resolveFreeAnswer(room, round, def);
  else if (def.responseMode === "challenge") resultPayload = resolveChallenge(room, round, def, verdict);
  else resultPayload = { kind: def.responseMode };

  act.status = "revealed";
  round.verdict = resultPayload.verdict || null;

  room.history.push({
    activityId: round.activityId,
    type: round.mode,
    text: round.text,
    top: def.responseMode === "poll" ? topLabel(resultPayload, room) : null,
    matched: resultPayload.matched ?? null,
    askedBy: round.askedBy,
    ts: Date.now()
  });

  io.to(room.code).emit("activity:results", {
    roundId: round.id, activityId: round.activityId, ...resultPayload, players: publicRoom(room).players
  });
  emitLegacyResults(room, round, resultPayload);
  analytics.track("activity_round_completed", room.code, { activityId: round.activityId, responseMode: def.responseMode });
}

function emitLegacyResults(room, round, resultPayload) {
  if (round.activityId === "vote-person") {
    const results = resultPayload.tally
      .map(([token, count]) => {
        const p = room.players.get(token);
        return { token, nickname: p ? p.nickname : "Unknown", color: p ? p.color : "#999", count };
      })
      .sort((a, b) => b.count - a.count);
    io.to(room.code).emit("squad:results", { questionId: round.id, text: round.text, results, players: publicRoom(room).players });
  } else if (round.activityId === "match") {
    const [t1, t2] = [...round.requiredResponders];
    const pA = room.players.get(t1), pB = room.players.get(t2);
    io.to(room.code).emit("duo:results", {
      questionId: round.id, kind: "match", text: round.text, a: round.a, b: round.b, matched: resultPayload.matched,
      answers: [
        { nickname: pA ? pA.nickname : "Player 1", color: pA ? pA.color : "#999", answer: round.responses.get(t1) },
        { nickname: pB ? pB.nickname : "Player 2", color: pB ? pB.color : "#999", answer: round.responses.get(t2) }
      ],
      players: publicRoom(room).players
    });
  } else if (round.activityId === "open-question") {
    const [t1, t2] = [...round.requiredResponders];
    const pA = room.players.get(t1), pB = room.players.get(t2);
    io.to(room.code).emit("duo:results", {
      questionId: round.id, kind: "open", text: round.text, matched: null,
      answers: [
        { nickname: pA ? pA.nickname : "Player 1", color: pA ? pA.color : "#999", answer: round.responses.get(t1) },
        { nickname: pB ? pB.nickname : "Player 2", color: pB ? pB.color : "#999", answer: round.responses.get(t2) }
      ],
      players: publicRoom(room).players
    });
  }
}

io.on("connection", socket => {
  let currentRoomCode = null;
  let currentToken = null;

  // ---------- CREATE ROOM ----------
  socket.on("create-room", ({ nickname, avatar, token }, ack) => {
    try {
      nickname = (nickname || "Guest").trim().slice(0, 20) || "Guest";
      let code;
      do { code = genCode(); } while (rooms.has(code));

      const room = {
        code, name: makeName(), createdAt: Date.now(),
        players: new Map(), mode: null, phase: "lobby",
        activity: freshActivityState(), casualTopic: null,
        voiceParticipants: new Set(),
        history: [], reports: []
      };
      rooms.set(code, room);

      const playerToken = token || `${socket.id}-${Date.now()}`;
      const player = {
        token: playerToken, nickname, avatar: avatar || "🙂", color: pickColor(room),
        score: 0, connected: true, socketId: socket.id, isHost: true, joinedAt: Date.now(), votesWon: 0
      };
      room.players.set(playerToken, player);

      socket.join(code);
      currentRoomCode = code;
      currentToken = playerToken;

      analytics.track("room_created", code, {});
      ack && ack({ ok: true, code, token: playerToken, room: publicRoom(room) });
    } catch (err) {
      ack && ack({ ok: false, error: "Could not create room. Please try again." });
    }
  });

  // ---------- JOIN ROOM ----------
  socket.on("join-room", ({ code, nickname, avatar, token }, ack) => {
    code = (code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return ack && ack({ ok: false, error: "That room code doesn't exist. Double-check it with whoever sent it." });

    if (token && room.players.has(token)) {
      const p = room.players.get(token);
      p.connected = true;
      p.socketId = socket.id;
      delete p.disconnectedAt;
      socket.join(code);
      currentRoomCode = code;
      currentToken = token;
      broadcastLobby(room);
      analytics.track("player_reconnected", code, {});

      const act = room.activity;
      if (act.status === "asking" && act.round) {
        const round = act.round;
        const def = activityCatalog[round.activityId];
        emitActivityQuestion(io.to(socket.id), room, round, def);
        emitLegacyQuestionStart(io.to(socket.id), room, round);
        if (round.responses.has(token)) {
          io.to(socket.id).emit("activity:restore-response", { roundId: round.id, value: round.responses.get(token) });
          if (round.activityId === "vote-person") io.to(socket.id).emit("squad:restore-vote", { targetToken: round.responses.get(token) });
          else if (round.activityId === "match") io.to(socket.id).emit("duo:restore-answer", { choice: round.responses.get(token) });
          else if (round.activityId === "open-question") io.to(socket.id).emit("duo:restore-answer", { text: round.responses.get(token) });
        }
      }

      return ack && ack({ ok: true, code, token, room: publicRoom(room), rejoined: true, mode: room.mode, phase: room.phase });
    }

    if (room.players.size >= 16) return ack && ack({ ok: false, error: "This room is full." });

    nickname = (nickname || "Guest").trim().slice(0, 20) || "Guest";
    const taken = new Set([...room.players.values()].map(p => p.nickname.toLowerCase()));
    let finalNick = nickname;
    let i = 2;
    while (taken.has(finalNick.toLowerCase())) { finalNick = `${nickname} (${i++})`; }

    const playerToken = token || `${socket.id}-${Date.now()}`;
    const player = {
      token: playerToken, nickname: finalNick, avatar: avatar || "🙂", color: pickColor(room),
      score: 0, connected: true, socketId: socket.id, isHost: room.players.size === 0, joinedAt: Date.now(), votesWon: 0
    };
    room.players.set(playerToken, player);
    socket.join(code);
    currentRoomCode = code;
    currentToken = playerToken;

    broadcastLobby(room);
    io.to(code).emit("toast", { text: `${finalNick} joined the room` });
    analytics.track("player_joined", code, { playerCount: room.players.size });
    ack && ack({ ok: true, code, token: playerToken, room: publicRoom(room) });
  });

  // ---------- LEAVE ROOM ----------
  socket.on("leave-room", () => handleLeave(socket, currentRoomCode, currentToken, true));

  // ---------- RENAME ROOM ----------
  socket.on("room:rename", name => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    room.name = (name || "").trim().slice(0, 30) || room.name;
    broadcastLobby(room);
  });

  // ---------- START MODE ----------
  socket.on("mode:start", mode => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const player = room.players.get(currentToken);
    if (!player || !player.isHost) return;
    if (mode === "duo" && room.players.size !== 2) {
      socket.emit("toast", { text: "Duo needs exactly 2 players in the room." });
      return;
    }
    room.mode = mode;
    room.phase = mode;
    room.activity = freshActivityState();
    if (mode === "casual") {
      room.casualTopic = getCasualTopic(null);
    }
    broadcastLobby(room);
    if (mode === "casual") io.to(room.code).emit("casual:topic", { text: room.casualTopic });
    analytics.track("mode_started", room.code, { mode, playerCount: room.players.size });
  });

  socket.on("mode:back-to-lobby", () => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const player = room.players.get(currentToken);
    if (!player || !player.isHost) return;
    clearActivityTimers(room);
    room.mode = null;
    room.phase = "lobby";
    room.activity = freshActivityState();
    room.casualTopic = null;
    broadcastLobby(room);
  });

  // ---------- VOICE CHAT: WebRTC signaling relay only — no audio touches the server ----------
  socket.on("voice:join", (_, ack) => {
    const room = rooms.get(currentRoomCode);
    if (!room) { ack && ack({ ok: false }); return; }
    const existing = [...room.voiceParticipants].filter(t => t !== currentToken);
    room.voiceParticipants.add(currentToken);
    // Existing participants each become the initiator toward the newcomer —
    // this avoids both sides racing to create an offer at once (SDP "glare").
    socket.to(room.code).emit("voice:participant-joined", { token: currentToken });
    broadcastLobby(room);
    analytics.track("voice_joined", room.code, { participantCount: room.voiceParticipants.size });
    ack && ack({ ok: true, existingParticipants: existing });
  });

  socket.on("voice:leave", () => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    room.voiceParticipants.delete(currentToken);
    io.to(room.code).emit("voice:participant-left", { token: currentToken });
    broadcastLobby(room);
  });

  socket.on("voice:signal", ({ toToken, signal }) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const target = room.players.get(toToken);
    if (!target || !target.socketId) return;
    io.to(target.socketId).emit("voice:signal", { fromToken: currentToken, signal });
  });

  // ---------- CASUAL TALKS: shuffle the conversation starter (anyone can) ----------
  socket.on("casual:shuffle-topic", () => {
    const room = rooms.get(currentRoomCode);
    if (!room || room.mode !== "casual") return;
    room.casualTopic = getCasualTopic(room.casualTopic);
    io.to(room.code).emit("casual:topic", { text: room.casualTopic });
  });

  // ---------- category lists (unchanged — still power vote-person / match / open-question) ----------
  socket.on("squad:categories", ack => ack && ack(squadCategoryMeta));
  socket.on("duo:categories", ack => ack && ack(duoCategoryMeta));

  // ---------- LEGACY ADAPTERS: squad:ask / squad:vote / duo:ask / duo:answer ----------
  socket.on("squad:ask", ({ source, category, text }) => {
    const room = rooms.get(currentRoomCode);
    if (!room || room.mode !== "squad") return;
    startRound(room, "vote-person", { source, category, text, askedByToken: currentToken });
  });

  socket.on("squad:vote", ({ questionId, targetToken }) => {
    const room = rooms.get(currentRoomCode);
    if (!room || room.mode !== "squad") return;
    if (!room.players.has(targetToken)) return;
    submitResponse(room, currentToken, questionId, targetToken);
  });

  socket.on("duo:ask", ({ kind, source, category, text, a, b }) => {
    const room = rooms.get(currentRoomCode);
    if (!room || room.mode !== "duo") return;
    const activityId = kind === "match" ? "match" : "open-question";
    startRound(room, activityId, { source, category, text, a, b, askedByToken: currentToken });
  });

  socket.on("duo:answer", ({ questionId, choice, text }) => {
    const room = rooms.get(currentRoomCode);
    if (!room || room.mode !== "duo") return;
    const round = room.activity.round;
    if (!round) return;
    const value = round.activityId === "match" ? choice : (text || "").trim().slice(0, 300);
    submitResponse(room, currentToken, questionId, value);
  });

  // ---------- NEW GENERIC ACTIVITY EVENTS (Truth, Hot Seat, Dare, NHIE, Would You Rather) ----------
  socket.on("activity:ask", ({ activityId, source, category, text, a, b }) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const def = activityCatalog[activityId];
    if (!def || def.mode !== room.mode) return;
    startRound(room, activityId, { source, category, text, a, b, askedByToken: currentToken });
  });

  socket.on("activity:respond", ({ roundId, value }) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    submitResponse(room, currentToken, roundId, value);
  });

  socket.on("activity:attempt", ({ roundId }) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const round = room.activity.round;
    if (!round || round.id !== roundId || round.performerToken !== currentToken) return;
    submitResponse(room, currentToken, roundId, true);
  });

  socket.on("activity:verify", ({ roundId, verdict }) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    submitVerdict(room, currentToken, roundId, verdict);
  });

  // ---------- SESSION END / RECAP ----------
  socket.on("session:end", () => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const player = room.players.get(currentToken);
    if (!player || !player.isHost) return;
    clearActivityTimers(room);
    room.phase = "recap";
    const recap = buildRecap(room);
    io.to(room.code).emit("session:recap", recap);
    analytics.track("session_ended", room.code, {
      questionsAnswered: recap.questionsAnswered, playerCount: room.players.size, durationMs: Date.now() - room.createdAt
    });
  });

  socket.on("session:replay", () => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const player = room.players.get(currentToken);
    if (!player || !player.isHost) return;
    clearActivityTimers(room);
    room.mode = null;
    room.phase = "lobby";
    room.activity = freshActivityState();
    broadcastLobby(room);
    analytics.track("session_replayed", room.code, {});
  });

  socket.on("session:rematch", () => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const player = room.players.get(currentToken);
    if (!player || !player.isHost) return;
    if (!room.mode) return;
    clearActivityTimers(room);
    room.phase = room.mode;
    room.activity = freshActivityState();
    broadcastLobby(room);
    analytics.track("session_rematch", room.code, { mode: room.mode });
  });

  // ---------- REACTIONS ----------
  socket.on("reaction:send", emoji => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const p = room.players.get(currentToken);
    if (!p) return;
    io.to(room.code).emit("reaction:incoming", { emoji, nickname: p.nickname, color: p.color });
  });

  // ---------- TYPING PRESENCE ----------
  let typingTimeout;
  socket.on("presence:typing", () => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const p = room.players.get(currentToken);
    if (!p) return;
    io.to(room.code).emit("presence:typing", { nickname: p.nickname });
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      io.to(room.code).emit("presence:stopped-typing", { nickname: p.nickname });
    }, 2500);
  });

  // ---------- SAFETY: report ----------
  socket.on("safety:report", ({ targetToken, reason }) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const reporter = room.players.get(currentToken);
    const target = room.players.get(targetToken);
    if (!reporter || !target) return;
    room.reports.push({ from: reporter.nickname, target: target.nickname, reason: (reason || "").slice(0, 200), ts: Date.now() });
    console.log(`[REPORT] room=${room.code} target=${target.nickname} from=${reporter.nickname} reason="${reason || ""}"`);
    const host = [...room.players.values()].find(p => p.isHost);
    if (host && host.socketId) {
      io.to(host.socketId).emit("safety:report-received", { target: target.nickname, count: room.reports.length });
    }
    socket.emit("toast", { text: "Report sent. The room host has been notified." });
    analytics.track("report_submitted", room.code, { hasReason: !!reason });
  });

  // ---------- SAFETY: kick (host only) ----------
  socket.on("safety:kick", targetToken => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const host = room.players.get(currentToken);
    if (!host || !host.isHost) return;
    const target = room.players.get(targetToken);
    if (!target) return;
    room.players.delete(targetToken);
    if (room.voiceParticipants && room.voiceParticipants.has(targetToken)) {
      room.voiceParticipants.delete(targetToken);
      io.to(room.code).emit("voice:participant-left", { token: targetToken });
    }
    if (target.socketId) io.to(target.socketId).emit("safety:kicked");
    broadcastLobby(room);
  });

  // ---------- SAFETY: pause / skip question (host only) ----------
  socket.on("safety:skip-question", () => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const host = room.players.get(currentToken);
    if (!host || !host.isHost) return;
    if (room.activity.status === "asking" || room.activity.status === "awaiting-verification") {
      const round = room.activity.round;
      const activityId = round ? round.activityId : null;
      clearActivityTimers(room);
      room.activity.status = "idle";
      room.activity.round = null;
      if (activityId === "vote-person") io.to(room.code).emit("squad:skipped");
      else if (activityId === "match" || activityId === "open-question") io.to(room.code).emit("duo:skipped");
      io.to(room.code).emit("activity:skipped");
    }
  });

  // ---------- DISCONNECT ----------
  socket.on("disconnect", () => handleLeave(socket, currentRoomCode, currentToken, false));
});

function reassignHostIfNeeded(room, removedPlayer) {
  if (!removedPlayer.isHost) return;
  removedPlayer.isHost = false;
  const next = [...room.players.values()].find(p => p.connected);
  if (next) next.isHost = true;
}

function handleLeave(socket, code, token, explicit) {
  const room = rooms.get(code);
  if (!room || !token) return;
  const player = room.players.get(token);
  if (!player) return;

  // Voice is a live WebRTC connection independent of the reconnection grace
  // window below — the instant a socket drops, that peer's audio is already
  // gone for everyone else, so clean it up immediately either way rather than
  // leaving other clients holding dead peer connections for up to 2 minutes.
  if (room.voiceParticipants && room.voiceParticipants.has(token)) {
    room.voiceParticipants.delete(token);
    io.to(room.code).emit("voice:participant-left", { token });
  }

  if (explicit) {
    room.players.delete(token);
    socket.leave(code);
    reassignHostIfNeeded(room, player);
    if (room.players.size === 0) { rooms.delete(room.code); return; }
    broadcastLobby(room);
  } else {
    player.connected = false;
    player.disconnectedAt = Date.now();
    broadcastLobby(room);
    setTimeout(() => {
      const p = room.players.get(token);
      if (p && !p.connected && Date.now() - (p.disconnectedAt || 0) >= REMOVAL_GRACE_MS - 50) {
        room.players.delete(token);
        reassignHostIfNeeded(room, p);
        if (room.players.size === 0) { rooms.delete(room.code); return; }
        broadcastLobby(room);
      }
    }, REMOVAL_GRACE_MS);
  }
}

function buildRecap(room) {
  const players = [...room.players.values()].sort((a, b) => b.score - a.score);
  const squadHistory = room.history.filter(h => h.type === "squad");
  const duoHistory = room.history.filter(h => h.type === "duo" && h.activityId === "match");

  const mostVoted = (() => {
    const counts = {};
    squadHistory.forEach(h => { if (h.top) counts[h.top] = (counts[h.top] || 0) + 1; });
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return entries.length ? { nickname: entries[0][0], count: entries[0][1] } : null;
  })();

  const matchCount = duoHistory.filter(h => h.matched).length;
  const matchTotal = duoHistory.length;

  const mostActive = (() => {
    const counts = {};
    room.history.forEach(h => { if (h.askedBy) counts[h.askedBy] = (counts[h.askedBy] || 0) + 1; });
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return entries.length ? { nickname: entries[0][0], count: entries[0][1] } : null;
  })();

  const winner = players.length && players[0].score > 0 ? { nickname: players[0].nickname, score: players[0].score } : null;

  return {
    leaderboard: players.map(p => ({ nickname: p.nickname, avatar: p.avatar, color: p.color, score: p.score })),
    winner, mostVoted, mostActive,
    duoMatch: matchTotal ? { matched: matchCount, total: matchTotal } : null,
    questionsAnswered: room.history.length,
    roomName: room.name
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`BONGA server running on port ${PORT}`);
});
