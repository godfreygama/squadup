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
// Room: {
//   code, name, hostToken, createdAt,
//   players: Map<token, {token, nickname, avatar, color, score, connected, socketId, isHost, joinedAt, votesWon}>,
//   mode: null|'squad'|'duo', phase: 'lobby'|'squad'|'duo'|'recap',
//   squad: { status:'idle'|'asking'|'revealed', question, timer },
//   duo: { status, question, timer },
//   history: [ {type, text, result, ts} ],
//   reports: [ {from, target, reason, ts} ]
// }
const rooms = new Map();
const REMOVAL_GRACE_MS = 2 * 60 * 1000; // 2 minutes to reconnect before a player is dropped
const SQUAD_TIMER_MS = 30 * 1000;
const DUO_TIMER_MS = 45 * 1000;

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

function findPlayerBySocket(room, socketId) {
  return [...room.players.values()].find(p => p.socketId === socketId);
}

function makeName() {
  const adjectives = ["Friday", "Late Night", "Golden", "Chaotic", "Cozy", "Wild", "Sunset", "Rooftop"];
  const nouns = ["Crew", "Night", "Circle", "Squad", "Hangout", "Gathering"];
  return `${adjectives[Math.floor(Math.random() * adjectives.length)]} ${nouns[Math.floor(Math.random() * nouns.length)]}`;
}

function clearTimer(t) {
  if (t) clearTimeout(t);
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
        code,
        name: makeName(),
        createdAt: Date.now(),
        players: new Map(),
        mode: null,
        phase: "lobby",
        squad: { status: "idle", question: null, timer: null },
        duo: { status: "idle", question: null, timer: null },
        history: [],
        reports: []
      };
      rooms.set(code, room);

      const playerToken = token || `${socket.id}-${Date.now()}`;
      const player = {
        token: playerToken,
        nickname,
        avatar: avatar || "🙂",
        color: pickColor(room),
        score: 0,
        connected: true,
        socketId: socket.id,
        isHost: true,
        joinedAt: Date.now(),
        votesWon: 0
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

    // Reconnection path: same token already in room
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
      token: playerToken,
      nickname: finalNick,
      avatar: avatar || "🙂",
      color: pickColor(room),
      score: 0,
      connected: true,
      socketId: socket.id,
      isHost: room.players.size === 0,
      joinedAt: Date.now(),
      votesWon: 0
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
    broadcastLobby(room);
    analytics.track("mode_started", room.code, { mode, playerCount: room.players.size });
  });

  socket.on("mode:back-to-lobby", () => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const player = room.players.get(currentToken);
    if (!player || !player.isHost) return;
    clearTimer(room.squad.timer);
    clearTimer(room.duo.timer);
    room.mode = null;
    room.phase = "lobby";
    room.squad = { status: "idle", question: null, timer: null };
    room.duo = { status: "idle", question: null, timer: null };
    broadcastLobby(room);
  });

  // ---------- SQUAD: get category list ----------
  socket.on("squad:categories", ack => ack && ack(squadCategoryMeta));
  socket.on("duo:categories", ack => ack && ack(duoCategoryMeta));

  // ---------- SQUAD: ask question ----------
  socket.on("squad:ask", ({ source, category, text }) => {
    const room = rooms.get(currentRoomCode);
    if (!room || room.mode !== "squad") return;
    const asker = room.players.get(currentToken);
    if (!asker) return;
    if (room.squad.status === "asking") return;

    let questionText;
    if (source === "custom") {
      questionText = (text || "").trim().slice(0, 200);
      if (!questionText) return;
    } else {
      questionText = getSquadQuestion(category || "mixed").text;
    }

    const question = {
      id: `${Date.now()}`,
      text: questionText,
      askedBy: asker.nickname,
      votes: new Map(), // voterToken -> targetToken
      startedAt: Date.now()
    };
    room.squad.question = question;
    room.squad.status = "asking";
    clearTimer(room.squad.timer);
    room.squad.timer = setTimeout(() => revealSquad(room), SQUAD_TIMER_MS);

    io.to(room.code).emit("squad:question", {
      id: question.id,
      text: question.text,
      askedBy: question.askedBy,
      durationMs: SQUAD_TIMER_MS,
      players: publicRoom(room).players
    });
    analytics.track("squad_question_asked", room.code, { source, category: category || null });
  });

  socket.on("squad:vote", ({ questionId, targetToken }) => {
    const room = rooms.get(currentRoomCode);
    if (!room || room.mode !== "squad" || room.squad.status !== "asking") return;
    const q = room.squad.question;
    if (!q || q.id !== questionId) return;
    if (!room.players.has(targetToken)) return;
    q.votes.set(currentToken, targetToken);

    io.to(room.code).emit("squad:progress", { answered: q.votes.size, total: room.players.size });
    if (q.votes.size >= room.players.size) {
      clearTimer(room.squad.timer);
      revealSquad(room);
    }
  });

  // ---------- DUO: ask question ----------
  socket.on("duo:ask", ({ kind, source, category, text, a, b }) => {
    const room = rooms.get(currentRoomCode);
    if (!room || room.mode !== "duo") return;
    const asker = room.players.get(currentToken);
    if (!asker) return;
    if (room.duo.status === "asking") return;

    let question;
    if (kind === "match") {
      if (source === "custom") {
        const optA = (a || "").trim().slice(0, 60);
        const optB = (b || "").trim().slice(0, 60);
        if (!optA || !optB) return;
        question = { kind: "match", a: optA, b: optB, category: "custom" };
      } else {
        question = { kind: "match", ...getDuoThisOrThat(category || "mixed") };
      }
    } else {
      let promptText;
      if (source === "custom") {
        promptText = (text || "").trim().slice(0, 200);
        if (!promptText) return;
      } else {
        promptText = getDuoOpen(category || "how-well");
      }
      question = { kind: "open", text: promptText };
    }

    question.id = `${Date.now()}`;
    question.askedBy = asker.nickname;
    question.answers = new Map();
    question.startedAt = Date.now();
    room.duo.question = question;
    room.duo.status = "asking";
    clearTimer(room.duo.timer);
    room.duo.timer = setTimeout(() => revealDuo(room), DUO_TIMER_MS);

    io.to(room.code).emit("duo:question", {
      id: question.id,
      kind: question.kind,
      text: question.text,
      a: question.a,
      b: question.b,
      askedBy: question.askedBy,
      durationMs: DUO_TIMER_MS
    });
    analytics.track("duo_question_asked", room.code, { kind, source, category: category || null });
  });

  socket.on("duo:answer", ({ questionId, choice, text }) => {
    const room = rooms.get(currentRoomCode);
    if (!room || room.mode !== "duo" || room.duo.status !== "asking") return;
    const q = room.duo.question;
    if (!q || q.id !== questionId) return;
    q.answers.set(currentToken, q.kind === "match" ? choice : (text || "").trim().slice(0, 300));

    io.to(room.code).emit("duo:progress", { answered: q.answers.size, total: 2 });
    if (q.answers.size >= 2) {
      clearTimer(room.duo.timer);
      revealDuo(room);
    }
  });

  // ---------- SESSION END / RECAP ----------
  socket.on("session:end", () => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const player = room.players.get(currentToken);
    if (!player || !player.isHost) return;
    clearTimer(room.squad.timer);
    clearTimer(room.duo.timer);
    room.phase = "recap";
    const recap = buildRecap(room);
    io.to(room.code).emit("session:recap", recap);
    analytics.track("session_ended", room.code, {
      questionsAnswered: recap.questionsAnswered,
      playerCount: room.players.size,
      durationMs: Date.now() - room.createdAt
    });
  });

  socket.on("session:replay", () => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const player = room.players.get(currentToken);
    if (!player || !player.isHost) return;
    room.mode = null;
    room.phase = "lobby";
    room.squad = { status: "idle", question: null, timer: null };
    room.duo = { status: "idle", question: null, timer: null };
    broadcastLobby(room);
    analytics.track("session_replayed", room.code, {});
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
    if (target.socketId) io.to(target.socketId).emit("safety:kicked");
    broadcastLobby(room);
  });

  // ---------- SAFETY: pause / skip question (host only) ----------
  socket.on("safety:skip-question", () => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const host = room.players.get(currentToken);
    if (!host || !host.isHost) return;
    if (room.mode === "squad" && room.squad.status === "asking") {
      clearTimer(room.squad.timer);
      room.squad.status = "idle";
      room.squad.question = null;
      io.to(room.code).emit("squad:skipped");
    } else if (room.mode === "duo" && room.duo.status === "asking") {
      clearTimer(room.duo.timer);
      room.duo.status = "idle";
      room.duo.question = null;
      io.to(room.code).emit("duo:skipped");
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

  if (explicit) {
    room.players.delete(token);
    socket.leave(code);
    reassignHostIfNeeded(room, player);

    if (room.players.size === 0) {
      rooms.delete(room.code);
      return;
    }
    broadcastLobby(room);
  } else {
    // Network drop: keep the player's seat (and host status) for a grace period in case they reconnect.
    player.connected = false;
    player.disconnectedAt = Date.now();
    broadcastLobby(room);

    setTimeout(() => {
      const p = room.players.get(token);
      if (p && !p.connected && Date.now() - (p.disconnectedAt || 0) >= REMOVAL_GRACE_MS - 50) {
        room.players.delete(token);
        reassignHostIfNeeded(room, p);
        if (room.players.size === 0) {
          rooms.delete(room.code);
          return;
        }
        broadcastLobby(room);
      }
    }, REMOVAL_GRACE_MS);
  }
}

function revealSquad(room) {
  const q = room.squad.question;
  if (!q) return;
  const tally = new Map();
  for (const targetToken of q.votes.values()) {
    tally.set(targetToken, (tally.get(targetToken) || 0) + 1);
  }
  const results = [...tally.entries()]
    .map(([token, count]) => {
      const p = room.players.get(token);
      return { token, nickname: p ? p.nickname : "Unknown", color: p ? p.color : "#999", count };
    })
    .sort((a, b) => b.count - a.count);

  // Points: participation +1 for everyone who voted, +5 bonus to whoever received the most votes
  for (const voterToken of q.votes.keys()) {
    const p = room.players.get(voterToken);
    if (p) p.score += 1;
  }
  if (results.length) {
    const topCount = results[0].count;
    results.filter(r => r.count === topCount).forEach(r => {
      const p = room.players.get(r.token);
      if (p) { p.score += 5; p.votesWon += 1; }
    });
  }

  room.squad.status = "revealed";
  room.history.push({ type: "squad", text: q.text, top: results[0] ? results[0].nickname : null, ts: Date.now() });

  io.to(room.code).emit("squad:results", {
    questionId: q.id,
    text: q.text,
    results,
    players: publicRoom(room).players
  });
  analytics.track("squad_question_completed", room.code, { votesCast: q.votes.size, playerCount: room.players.size });
}

function revealDuo(room) {
  const q = room.duo.question;
  if (!q) return;
  const [tokenA, tokenB] = [...room.players.keys()];
  const pA = room.players.get(tokenA);
  const pB = room.players.get(tokenB);
  const answerA = q.answers.get(tokenA);
  const answerB = q.answers.get(tokenB);

  let matched = null;
  if (q.kind === "match") {
    matched = answerA && answerB && answerA === answerB;
    if (matched) {
      if (pA) pA.score += 3;
      if (pB) pB.score += 3;
    } else {
      if (pA && answerA) pA.score += 1;
      if (pB && answerB) pB.score += 1;
    }
  } else {
    if (pA && answerA) pA.score += 1;
    if (pB && answerB) pB.score += 1;
  }

  room.duo.status = "revealed";
  room.history.push({
    type: "duo",
    kind: q.kind,
    text: q.kind === "match" ? `${q.a} or ${q.b}` : q.text,
    matched,
    ts: Date.now()
  });

  io.to(room.code).emit("duo:results", {
    questionId: q.id,
    kind: q.kind,
    text: q.text,
    a: q.a,
    b: q.b,
    matched,
    answers: [
      { nickname: pA ? pA.nickname : "Player 1", color: pA ? pA.color : "#999", answer: answerA },
      { nickname: pB ? pB.nickname : "Player 2", color: pB ? pB.color : "#999", answer: answerB }
    ],
    players: publicRoom(room).players
  });
  analytics.track("duo_question_completed", room.code, { kind: q.kind, matched });
}

function buildRecap(room) {
  const players = [...room.players.values()].sort((a, b) => b.score - a.score);
  const squadHistory = room.history.filter(h => h.type === "squad");
  const duoHistory = room.history.filter(h => h.type === "duo");

  const mostVoted = (() => {
    const counts = {};
    squadHistory.forEach(h => { if (h.top) counts[h.top] = (counts[h.top] || 0) + 1; });
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return entries.length ? { nickname: entries[0][0], count: entries[0][1] } : null;
  })();

  const matchCount = duoHistory.filter(h => h.kind === "match" && h.matched).length;
  const matchTotal = duoHistory.filter(h => h.kind === "match").length;

  return {
    leaderboard: players.map(p => ({ nickname: p.nickname, avatar: p.avatar, color: p.color, score: p.score })),
    mostVoted,
    duoMatch: matchTotal ? { matched: matchCount, total: matchTotal } : null,
    questionsAnswered: room.history.length,
    roomName: room.name
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`BONGA server running on port ${PORT}`);
});
