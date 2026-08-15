(() => {
  "use strict";

  const socket = io();
  const AVATARS = ["🙂","😎","🥳","🤠","🦄","🐸","🔥","👑","🎧","🌈","🦊","🐼","🧃","🍕","👻","🤖"];

  // ---------------- persisted identity ----------------
  const store = {
    get token() { return localStorage.getItem("bonga_token"); },
    set token(v) { localStorage.setItem("bonga_token", v); },
    get nickname() { return localStorage.getItem("bonga_nickname") || ""; },
    set nickname(v) { localStorage.setItem("bonga_nickname", v); },
    get avatar() { return localStorage.getItem("bonga_avatar") || AVATARS[0]; },
    set avatar(v) { localStorage.setItem("bonga_avatar", v); },
    get lastRoom() { return localStorage.getItem("bonga_last_room") || ""; },
    set lastRoom(v) { localStorage.setItem("bonga_last_room", v); }
  };

  // ---------------- state ----------------
  const S = {
    code: null,
    room: null, // last room:state payload
    pendingAction: null, // 'create' | 'join'
    selectedAvatar: store.avatar,
    squadCategory: null,
    squadPreview: null,
    duoCategory: null,
    duoPreview: null,
    duoOpenKind: "how-well",
    duoOpenPreview: null,
    selectedVoteTarget: null,
    selectedDuoChoice: null,
    reportTarget: null
  };

  // ---------------- helpers ----------------
  const $ = id => document.getElementById(id);
  function showView(id) {
    document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
    $(id).classList.add("active");
  }
  function toast(text) {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = text;
    $("toast-stack").appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }
  function myToken() { return store.token; }
  function isHost() {
    if (!S.room) return false;
    const me = S.room.players.find(p => p.token === myToken());
    return me && me.isHost;
  }
  function meColor() {
    const me = S.room && S.room.players.find(p => p.token === myToken());
    return me ? me.color : "#7C5CFF";
  }

  // ---------------- landing ----------------
  $("btn-create").addEventListener("click", () => {
    S.pendingAction = "create";
    openNicknameModal("What should we call you?");
  });
  $("btn-show-join").addEventListener("click", () => {
    $("join-form").classList.toggle("hidden");
    if (!$("join-form").classList.contains("hidden")) $("join-code").focus();
  });
  $("join-form").addEventListener("submit", e => {
    e.preventDefault();
    const code = $("join-code").value.trim().toUpperCase();
    if (!code) return;
    S.pendingAction = "join";
    S.pendingCode = code;
    openNicknameModal("Almost there — pick a nickname");
  });

  // ---------------- nickname modal ----------------
  const avatarPicker = $("avatar-picker");
  AVATARS.forEach(a => {
    const b = document.createElement("button");
    b.className = "avatar-opt" + (a === S.selectedAvatar ? " selected" : "");
    b.textContent = a;
    b.type = "button";
    b.addEventListener("click", () => {
      S.selectedAvatar = a;
      [...avatarPicker.children].forEach(c => c.classList.remove("selected"));
      b.classList.add("selected");
    });
    avatarPicker.appendChild(b);
  });

  function openNicknameModal(title) {
    $("nickname-title").textContent = title;
    $("nickname-input").value = store.nickname;
    $("modal-nickname").classList.remove("hidden");
    setTimeout(() => $("nickname-input").focus(), 50);
  }
  $("nickname-cancel").addEventListener("click", () => $("modal-nickname").classList.add("hidden"));
  $("nickname-continue").addEventListener("click", submitNickname);
  $("nickname-input").addEventListener("keydown", e => { if (e.key === "Enter") submitNickname(); });

  function submitNickname() {
    const nickname = $("nickname-input").value.trim().slice(0, 20) || "Guest";
    store.nickname = nickname;
    store.avatar = S.selectedAvatar;
    $("modal-nickname").classList.add("hidden");

    if (S.pendingAction === "create") {
      socket.emit("create-room", { nickname, avatar: S.selectedAvatar, token: myToken() }, handleRoomAck);
    } else if (S.pendingAction === "join") {
      socket.emit("join-room", { code: S.pendingCode, nickname, avatar: S.selectedAvatar, token: myToken() }, handleRoomAck);
    }
  }

  function handleRoomAck(res) {
    if (!res || !res.ok) { toast(res && res.error ? res.error : "Something went wrong."); return; }
    store.token = res.token;
    store.lastRoom = res.code;
    S.code = res.code;
    renderRoom(res.room);
    if (res.rejoined && res.mode) {
      showView(res.mode === "squad" ? "view-squad" : "view-duo");
    } else {
      showView("view-lobby");
    }
    updateUrl(res.code);
  }

  function updateUrl(code) {
    const url = new URL(window.location.href);
    url.searchParams.set("room", code);
    window.history.replaceState({}, "", url);
  }

  // ---------------- auto-join via URL / reconnect ----------------
  window.addEventListener("load", () => {
    const params = new URLSearchParams(window.location.search);
    const roomFromUrl = params.get("room");
    const token = myToken();

    if (roomFromUrl && token && store.nickname) {
      socket.emit("join-room", { code: roomFromUrl.toUpperCase(), nickname: store.nickname, avatar: store.avatar, token }, res => {
        if (res && res.ok) { handleRoomAck(res); }
      });
    } else if (roomFromUrl) {
      $("join-code").value = roomFromUrl.toUpperCase();
      S.pendingAction = "join";
      S.pendingCode = roomFromUrl.toUpperCase();
      openNicknameModal("Join the room — pick a nickname");
    }
  });

  // ---------------- room state rendering ----------------
  socket.on("room:state", room => renderRoom(room));

  function renderRoom(room) {
    S.room = room;
    S.code = room.code;

    $("room-code-text").textContent = room.code;
    $("room-name").textContent = room.name;
    $("room-name").contentEditable = isHost() ? "true" : "false";
    $("btn-edit-name").classList.toggle("hidden", !isHost());
    $("player-count").textContent = room.players.length;

    renderPlayerGrid(room.players);
    renderHostPlayerList(room.players);

    $("btn-share").onclick = shareRoom;
    $("room-code-badge").onclick = copyCode;

    const duoDisabled = room.players.length !== 2;
    const duoCard = document.querySelector('.mode-card[data-mode="duo"]');
    duoCard.disabled = duoDisabled;
    $("duo-hint").style.display = duoDisabled ? "block" : "none";

    document.getElementById("squad-host-controls-btn").classList.toggle("hidden", !isHost());
    document.getElementById("squad-host-controls-btn-duo").classList.toggle("hidden", !isHost());

    // route based on phase (covers other players seeing host start a mode)
    if (room.phase === "squad" && !document.getElementById("view-squad").classList.contains("active")) {
      showView("view-squad");
    } else if (room.phase === "duo" && !document.getElementById("view-duo").classList.contains("active")) {
      showView("view-duo");
    } else if (room.phase === "lobby" && (document.getElementById("view-squad").classList.contains("active") || document.getElementById("view-duo").classList.contains("active"))) {
      resetSquadUI();
      resetDuoUI();
      showView("view-lobby");
    }
  }

  function renderPlayerGrid(players) {
    const grid = $("player-grid");
    grid.innerHTML = "";
    players.forEach(p => {
      const card = document.createElement("div");
      card.className = "player-card";
      card.innerHTML = `
        <div class="player-avatar ${p.connected ? "" : "offline"}" style="background:${p.color}33;">
          ${p.avatar}
          ${p.isHost ? '<span class="host-crown">👑</span>' : ""}
          <span class="presence-dot ${p.connected ? "" : "offline"}"></span>
        </div>
        <span class="player-name">${escapeHtml(p.nickname)}</span>
      `;
      grid.appendChild(card);
    });
  }

  function renderHostPlayerList(players) {
    const list = $("host-players-list");
    list.innerHTML = "";
    players.forEach(p => {
      const row = document.createElement("div");
      row.className = "host-player-row";
      const canKick = isHost() && p.token !== myToken();
      row.innerHTML = `
        <span style="font-size:18px;">${p.avatar}</span>
        <span>${escapeHtml(p.nickname)}${p.isHost ? " (host)" : ""}</span>
        <span class="hpr-actions">
          ${canKick ? `<button class="btn btn-text btn-sm" data-kick="${p.token}">Remove</button>` : ""}
        </span>
      `;
      list.appendChild(row);
    });
    list.querySelectorAll("[data-kick]").forEach(btn => {
      btn.addEventListener("click", () => {
        if (confirm("Remove this player from the room?")) socket.emit("safety:kick", btn.dataset.kick);
      });
    });
  }

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function renderDuoAnswerStatus(answeredTokens) {
    const list = $("duo-answer-status");
    if (!list || !S.room) return;
    const answeredSet = new Set(answeredTokens);
    list.innerHTML = S.room.players.map(p => `
      <div class="answer-status-row ${answeredSet.has(p.token) ? "answered" : ""}">
        <span class="answer-status-dot"></span>
        <span>${escapeHtml(p.nickname)}${p.token === myToken() ? " (you)" : ""}</span>
        <span class="answer-status-label">${answeredSet.has(p.token) ? "Answered" : "Thinking…"}</span>
      </div>
    `).join("");
  }

  // Tracks each player's own last-seen score so we can show "+N ⭐" exactly once
  // per change, and update the topbar readout, whenever a results payload arrives.
  let lastKnownScore = null;
  function updateStarsAndFlash(players, readoutId) {
    const me = players && players.find(p => p.token === myToken());
    if (!me) return;
    const readout = $(readoutId);
    if (readout) readout.textContent = `⭐ ${me.score}`;
    if (lastKnownScore !== null && me.score > lastKnownScore) {
      const delta = me.score - lastKnownScore;
      if (readout) {
        readout.classList.remove("bump");
        void readout.offsetWidth; // restart the animation if it's already mid-way
        readout.classList.add("bump");
      }
      const el = document.createElement("div");
      el.className = "floating-reaction";
      el.textContent = `+${delta} ⭐`;
      el.style.left = "50%";
      el.style.fontSize = "16px";
      el.style.fontWeight = "700";
      $("reaction-layer").appendChild(el);
      setTimeout(() => el.remove(), 2300);
    }
    lastKnownScore = me.score;
  }

  // ---------------- room name edit ----------------
  $("room-name").addEventListener("blur", () => {
    if (isHost()) socket.emit("room:rename", $("room-name").textContent);
  });
  $("room-name").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); $("room-name").blur(); } });

  // ---------------- share / copy ----------------
  function shareRoom() {
    const url = `${window.location.origin}/?room=${S.code}`;
    if (navigator.share) {
      navigator.share({ title: `Join ${S.room.name} on BONGA`, text: `Join my room "${S.room.name}" — code ${S.code}`, url }).catch(() => {});
    } else {
      navigator.clipboard.writeText(url).then(() => toast("Invite link copied!"));
    }
  }
  function copyCode() {
    navigator.clipboard.writeText(S.code).then(() => toast("Room code copied!"));
  }

  // ---------------- leaving ----------------
  function leaveRoom() {
    socket.emit("leave-room");
    localStorage.removeItem("bonga_token");
    window.history.replaceState({}, "", window.location.origin);
    location.reload();
  }
  $("btn-leave").addEventListener("click", () => { if (confirm("Leave this room?")) leaveRoom(); });
  $("btn-leave-squad").addEventListener("click", () => { if (isHost()) socket.emit("mode:back-to-lobby"); else if (confirm("Leave this room?")) leaveRoom(); });
  $("btn-leave-duo").addEventListener("click", () => { if (isHost()) socket.emit("mode:back-to-lobby"); else if (confirm("Leave this room?")) leaveRoom(); });

  // ---------------- mode selection ----------------
  document.querySelectorAll(".mode-card").forEach(card => {
    card.addEventListener("click", () => {
      if (card.disabled) return;
      socket.emit("mode:start", card.dataset.mode);
    });
  });

  // ================= SQUAD =================
  let squadCategories = [];
  socket.emit("squad:categories", cats => { squadCategories = cats; });

  const SQUAD_ACTIVITIES = [
    { id: "vote-person", label: "Who Knows Who?", emoji: "🗳️" },
    { id: "truth", label: "Truth", emoji: "💬" },
    { id: "hot-seat", label: "Hot Seat", emoji: "🔥" },
    { id: "dare", label: "Dare", emoji: "😈" },
    { id: "never-have-i-ever", label: "Never Have I Ever", emoji: "🙅" },
    { id: "would-you-rather", label: "Would You Rather", emoji: "🤔" }
  ];

  function resetSquadUI() {
    $("squad-idle").classList.remove("hidden");
    $("squad-question-panel").classList.add("hidden");
    $("squad-results-panel").classList.add("hidden");
    squadActivityKind = null;
    currentSquadActivityData = null;
    renderSquadActivityGrid();
  }

  function renderSquadActivityGrid() {
    const grid = $("squad-activity-grid");
    grid.innerHTML = "";
    SQUAD_ACTIVITIES.forEach(a => {
      const card = document.createElement("button");
      card.className = "activity-card";
      card.innerHTML = `<span class="activity-card-emoji">${a.emoji}</span><span class="activity-card-label">${a.label}</span>`;
      card.addEventListener("click", () => openActivityModal(a.id));
      grid.appendChild(card);
    });
  }
  renderSquadActivityGrid(); // static content — populate once at load rather than on every reset

  function openActivityModal(activityId) {
    if (activityId === "vote-person") { openSquadModal(); return; }
    if (activityId === "would-you-rather") { openWyrModal(); return; }
    openSimpleModal(activityId);
  }

  $("btn-squad-next").addEventListener("click", () => resetSquadUI());

  function openSquadModal() {
    if (!squadCategories.length) socket.emit("squad:categories", cats => { squadCategories = cats; renderSquadChips(); });
    else renderSquadChips();
    $("squad-custom-input").value = "";
    switchTab("modal-ask-squad", "suggested");
    $("modal-ask-squad").classList.remove("hidden");
  }
  function renderSquadChips() {
    const wrap = $("squad-category-chips");
    wrap.innerHTML = "";
    const mixed = document.createElement("button");
    mixed.className = "chip selected";
    mixed.textContent = "🎲 Mixed";
    mixed.dataset.cat = "mixed";
    wrap.appendChild(mixed);
    squadCategories.forEach(c => {
      const chip = document.createElement("button");
      chip.className = "chip";
      chip.textContent = c.label;
      chip.dataset.cat = c.id;
      wrap.appendChild(chip);
    });
    S.squadCategory = "mixed";
    wrap.querySelectorAll(".chip").forEach(chip => {
      chip.addEventListener("click", () => {
        wrap.querySelectorAll(".chip").forEach(c => c.classList.remove("selected"));
        chip.classList.add("selected");
        S.squadCategory = chip.dataset.cat;
        shuffleSquadPreview();
      });
    });
    shuffleSquadPreview();
  }
  function shuffleSquadPreview() {
    // client-side preview only pulls a short local sample; actual send re-rolls server-side unless custom
    $("squad-preview-text").textContent = "Tap “Ask the room” to get a fresh " + (S.squadCategory === "mixed" ? "surprise" : S.squadCategory) + " question.";
  }
  $("btn-squad-shuffle").addEventListener("click", shuffleSquadPreview);

  document.querySelectorAll('#modal-ask-squad .modal-tab').forEach(tab => {
    tab.addEventListener("click", () => switchTab("modal-ask-squad", tab.dataset.tab));
  });
  function switchTab(modalId, tabName) {
    const modal = $(modalId);
    modal.querySelectorAll(".modal-tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tabName));
    modal.querySelectorAll(".modal-tab-panel").forEach(p => {
      p.classList.toggle("hidden", !p.id.includes(tabName));
    });
  }

  $("btn-squad-cancel").addEventListener("click", () => $("modal-ask-squad").classList.add("hidden"));
  $("btn-squad-send").addEventListener("click", () => {
    const isCustom = !$("squad-custom-tab").classList.contains("hidden");
    if (isCustom) {
      const text = $("squad-custom-input").value.trim();
      if (!text) { toast("Type a question first."); return; }
      socket.emit("squad:ask", { source: "custom", text });
    } else {
      socket.emit("squad:ask", { source: "suggested", category: S.squadCategory || "mixed" });
    }
    $("modal-ask-squad").classList.add("hidden");
  });

  // ---------- simple modal: Truth / Hot Seat / Dare / Never Have I Ever ----------
  const SIMPLE_ACTIVITY_META = {
    truth: { title: "Truth", subtitle: "Goes to whoever's up next in the room." },
    "hot-seat": { title: "Hot Seat", subtitle: "One person stays in the seat for a few rounds." },
    dare: { title: "Dare", subtitle: "Goes to whoever's up next — a rotating judge verifies it." },
    "never-have-i-ever": { title: "Never Have I Ever", subtitle: "Everyone answers." }
  };
  let currentSimpleActivity = null;

  function openSimpleModal(activityId) {
    currentSimpleActivity = activityId;
    const meta = SIMPLE_ACTIVITY_META[activityId];
    $("simple-activity-title").textContent = meta.title;
    $("simple-activity-subtitle").textContent = meta.subtitle;
    $("simple-preview-text").textContent = "Tap shuffle for a prompt.";
    $("simple-custom-input").value = "";
    switchTab("modal-ask-simple", "suggested");
    $("modal-ask-simple").classList.remove("hidden");
  }
  $("btn-simple-shuffle").addEventListener("click", () => {
    $("simple-preview-text").textContent = "Shuffled — tap “Ask the room” to reveal it live.";
  });
  document.querySelectorAll('#modal-ask-simple .modal-tab').forEach(tab => {
    tab.addEventListener("click", () => switchTab("modal-ask-simple", tab.dataset.tab));
  });
  $("btn-simple-cancel").addEventListener("click", () => $("modal-ask-simple").classList.add("hidden"));
  $("btn-simple-send").addEventListener("click", () => {
    const isCustom = !$("simple-custom-tab").classList.contains("hidden");
    if (isCustom) {
      const text = $("simple-custom-input").value.trim();
      if (!text) { toast("Type a prompt first."); return; }
      socket.emit("activity:ask", { activityId: currentSimpleActivity, source: "custom", text });
    } else {
      socket.emit("activity:ask", { activityId: currentSimpleActivity, source: "suggested" });
    }
    $("modal-ask-simple").classList.add("hidden");
  });

  // ---------- Would You Rather modal ----------
  function openWyrModal() {
    $("wyr-preview-text").textContent = "Tap shuffle for a pair.";
    $("wyr-custom-a").value = ""; $("wyr-custom-b").value = "";
    switchTab("modal-ask-wyr", "suggested");
    $("modal-ask-wyr").classList.remove("hidden");
  }
  $("btn-wyr-shuffle").addEventListener("click", () => {
    $("wyr-preview-text").textContent = "Shuffled — tap “Ask the room” to reveal it live.";
  });
  document.querySelectorAll('#modal-ask-wyr .modal-tab').forEach(tab => {
    tab.addEventListener("click", () => switchTab("modal-ask-wyr", tab.dataset.tab));
  });
  $("btn-wyr-cancel").addEventListener("click", () => $("modal-ask-wyr").classList.add("hidden"));
  $("btn-wyr-send").addEventListener("click", () => {
    const isCustom = !$("wyr-custom-tab").classList.contains("hidden");
    if (isCustom) {
      const a = $("wyr-custom-a").value.trim(), b = $("wyr-custom-b").value.trim();
      if (!a || !b) { toast("Fill in both options."); return; }
      socket.emit("activity:ask", { activityId: "would-you-rather", source: "custom", a, b });
    } else {
      socket.emit("activity:ask", { activityId: "would-you-rather", source: "suggested" });
    }
    $("modal-ask-wyr").classList.add("hidden");
  });

  let squadTimerInterval;
  socket.on("squad:question", q => {
    squadActivityKind = null;
    currentSquadActivityData = null;
    $("squad-idle").classList.add("hidden");
    $("squad-results-panel").classList.add("hidden");
    $("squad-question-panel").classList.remove("hidden");
    $("squad-asked-by").textContent = q.askedBy;
    $("squad-question-text").textContent = q.text;
    $("squad-progress").textContent = `0 of ${q.players.length} answered`;
    S.selectedVoteTarget = null;
    S.currentSquadQuestion = q;

    $("squad-vote-grid").classList.remove("hidden");
    $("squad-poll-fixed-ui").classList.add("hidden");
    $("squad-freeanswer-ui").classList.add("hidden");
    $("squad-challenge-ui").classList.add("hidden");
    $("squad-timer-bar").classList.remove("hidden");

    const grid = $("squad-vote-grid");
    grid.innerHTML = "";
    q.players.forEach(p => {
      const opt = document.createElement("div");
      opt.className = "vote-option";
      opt.dataset.token = p.token;
      opt.innerHTML = `<div class="player-avatar" style="background:${p.color}33;">${p.avatar}</div><span class="player-name">${escapeHtml(p.nickname)}</span>`;
      opt.addEventListener("click", () => {
        grid.querySelectorAll(".vote-option").forEach(o => o.classList.remove("selected"));
        opt.classList.add("selected");
        S.selectedVoteTarget = p.token;
        socket.emit("squad:vote", { questionId: q.id, targetToken: p.token });
      });
      grid.appendChild(opt);
    });

    runTimer($("squad-timer-fill"), q.durationMs, squadTimerInterval, id => squadTimerInterval = id);
  });

  // Reconnected mid-question: restore which player we'd already voted for,
  // without re-submitting (the server already has our vote on record).
  socket.on("squad:restore-vote", ({ targetToken }) => {
    S.selectedVoteTarget = targetToken;
    const grid = $("squad-vote-grid");
    grid.querySelectorAll(".vote-option").forEach(o => o.classList.toggle("selected", o.dataset.token === targetToken));
  });

  socket.on("squad:progress", ({ answered, total, answeredTokens }) => {
    $("squad-progress").textContent = `${answered} of ${total} answered`;
    if (answeredTokens) {
      const grid = $("squad-vote-grid");
      const answeredSet = new Set(answeredTokens);
      grid.querySelectorAll(".vote-option").forEach(o => {
        o.classList.toggle("has-answered", answeredSet.has(o.dataset.token));
      });
    }
  });

  socket.on("squad:skipped", () => { toast("Host skipped that question."); resetSquadUI(); });

  socket.on("squad:results", data => {
    clearInterval(squadTimerInterval);
    $("squad-question-panel").classList.add("hidden");
    $("squad-results-panel").classList.remove("hidden");
    $("squad-results-text").textContent = data.text;
    updateStarsAndFlash(data.players, "squad-stars");

    const wrap = $("squad-results-bars");
    wrap.innerHTML = "";
    const max = Math.max(1, ...data.results.map(r => r.count));
    const topCount = data.results.length ? data.results[0].count : 0;

    // Ensure everyone shows even with 0 votes
    const allTokens = new Set(data.players.map(p => p.token));
    const resultMap = new Map(data.results.map(r => [r.token, r]));
    data.players.forEach(p => { if (!resultMap.has(p.token)) resultMap.set(p.token, { token: p.token, nickname: p.nickname, color: p.color, count: 0 }); });
    const rows = [...resultMap.values()].sort((a, b) => b.count - a.count);

    rows.forEach(r => {
      const row = document.createElement("div");
      row.className = "result-bar-row" + (r.count === topCount && topCount > 0 ? " winner" : "");
      row.innerHTML = `
        <div class="result-bar-avatar" style="background:${r.color}33;">${(data.players.find(p=>p.token===r.token)||{}).avatar || "🙂"}</div>
        <div class="result-bar-name">${escapeHtml(r.nickname)}</div>
        <div class="result-bar-track"><div class="result-bar-fill" style="width:0%; background: linear-gradient(135deg, ${r.color}, ${r.color}CC);"><span>${r.count}</span></div></div>
      `;
      wrap.appendChild(row);
      requestAnimationFrame(() => {
        row.querySelector(".result-bar-fill").style.width = `${Math.round((r.count / max) * 100)}%`;
      });
    });
  });

  // ================= NEW SQUAD ACTIVITIES (Truth, Hot Seat, Dare, NHIE, WYR) =================
  // These share the generic activity:* protocol with Duo's match/open-question
  // (same underlying engine) — this allowlist keeps this code from misfiring
  // when a Duo round happens to be live instead.
  const NEW_SQUAD_ACTIVITY_IDS = new Set(["truth", "hot-seat", "dare", "never-have-i-ever", "would-you-rather"]);
  let squadActivityKind = null; // which of the above (if any) is currently live, for progress/results routing
  let currentSquadActivityData = null; // activity:question payload doesn't get re-sent with results, so remember it here

  socket.on("activity:question", data => {
    if (!NEW_SQUAD_ACTIVITY_IDS.has(data.activityId)) return;
    squadActivityKind = data.activityId;
    currentSquadActivityData = data;

    $("squad-idle").classList.add("hidden");
    $("squad-results-panel").classList.add("hidden");
    $("squad-question-panel").classList.remove("hidden");
    $("squad-asked-by").textContent = data.askedBy;
    $("squad-question-text").textContent = data.text || "";
    $("squad-progress").textContent = "";

    $("squad-vote-grid").classList.add("hidden");
    $("squad-poll-fixed-ui").classList.add("hidden");
    $("squad-freeanswer-ui").classList.add("hidden");
    $("squad-challenge-ui").classList.add("hidden");
    $("squad-freeanswer-target-form").classList.add("hidden");
    $("squad-freeanswer-waiting").classList.add("hidden");
    $("btn-squad-challenge-attempt").classList.add("hidden");
    $("squad-challenge-verify").classList.add("hidden");

    $("squad-timer-bar").classList.toggle("hidden", !data.timed);

    if (data.responseMode === "poll") {
      $("squad-poll-fixed-ui").classList.remove("hidden");
      const wrap = $("squad-poll-fixed-options");
      wrap.innerHTML = "";
      const options = data.activityId === "would-you-rather" ? [data.a, data.b] : (data.fixedOptions || []);
      options.forEach((label, i) => {
        if (i === 1) {
          const vs = document.createElement("span");
          vs.className = "duo-vs";
          vs.textContent = "or";
          wrap.appendChild(vs);
        }
        const btn = document.createElement("button");
        btn.className = "duo-option";
        btn.textContent = label;
        btn.addEventListener("click", () => {
          wrap.querySelectorAll(".duo-option").forEach(o => o.classList.remove("selected"));
          btn.classList.add("selected");
          socket.emit("activity:respond", { roundId: data.id, value: label });
        });
        wrap.appendChild(btn);
      });
      $("squad-progress").textContent = `0 of ${data.players.length} answered`;
    } else if (data.responseMode === "freeAnswer") {
      $("squad-freeanswer-ui").classList.remove("hidden");
      const targetPlayer = data.players.find(p => p.token === data.targetToken);
      if (data.targetToken === myToken()) {
        $("squad-freeanswer-target-form").classList.remove("hidden");
        $("squad-freeanswer-input").value = "";
        setTimeout(() => $("squad-freeanswer-input").focus(), 100);
      } else {
        $("squad-freeanswer-waiting").classList.remove("hidden");
        $("squad-freeanswer-waiting").innerHTML = `Waiting for <span class="spotlight-name">${escapeHtml(targetPlayer ? targetPlayer.nickname : "someone")}</span> to answer…`;
      }
    } else if (data.responseMode === "challenge") {
      $("squad-challenge-ui").classList.remove("hidden");
      const performer = data.players.find(p => p.token === data.performerToken);
      if (data.performerToken === myToken()) {
        $("squad-challenge-role-text").textContent = "It's your dare — go do it, then tap below.";
        $("btn-squad-challenge-attempt").classList.remove("hidden");
      } else {
        $("squad-challenge-role-text").textContent = `${performer ? performer.nickname : "Someone"} is up for a dare.`;
      }
    }

    if (data.timed) runTimer($("squad-timer-fill"), data.durationMs, squadTimerInterval, id => squadTimerInterval = id);
  });

  $("btn-squad-freeanswer-submit").addEventListener("click", () => {
    const text = $("squad-freeanswer-input").value.trim();
    if (!text) { toast("Write something first."); return; }
    socket.emit("activity:respond", { roundId: currentSquadActivityData.id, value: text });
    $("squad-freeanswer-target-form").classList.add("hidden");
    $("squad-freeanswer-waiting").classList.remove("hidden");
    $("squad-freeanswer-waiting").textContent = "Answer submitted — revealing soon…";
  });

  $("btn-squad-challenge-attempt").addEventListener("click", () => {
    socket.emit("activity:attempt", { roundId: currentSquadActivityData.id });
    $("btn-squad-challenge-attempt").classList.add("hidden");
    $("squad-challenge-role-text").textContent = "Waiting for the judge's call…";
  });
  $("btn-challenge-pass").addEventListener("click", () => socket.emit("activity:verify", { roundId: currentSquadActivityData.id, verdict: "passed" }));
  $("btn-challenge-fail").addEventListener("click", () => socket.emit("activity:verify", { roundId: currentSquadActivityData.id, verdict: "failed" }));

  socket.on("activity:awaiting-verification", data => {
    $("btn-squad-challenge-attempt").classList.add("hidden");
    if (data.judgeToken === myToken()) {
      $("squad-challenge-role-text").textContent = "Did they pull it off? You're judging this one.";
      $("squad-challenge-verify").classList.remove("hidden");
    } else {
      $("squad-challenge-role-text").textContent = "Waiting for the judge's call…";
    }
  });

  socket.on("activity:progress", data => {
    if (!squadActivityKind) return; // vote-person's own squad:progress handler covers that case
    $("squad-progress").textContent = data.answered >= data.total ? "Revealing…" : `${data.answered} of ${data.total} answered`;
  });

  socket.on("activity:restore-response", data => {
    if (!currentSquadActivityData || currentSquadActivityData.responseMode !== "poll") return;
    $("squad-poll-fixed-options").querySelectorAll(".duo-option").forEach(btn => {
      btn.classList.toggle("selected", btn.textContent === data.value);
    });
  });

  socket.on("activity:results", data => {
    if (!NEW_SQUAD_ACTIVITY_IDS.has(data.activityId)) return;
    clearInterval(squadTimerInterval);
    updateStarsAndFlash(data.players, "squad-stars");
    $("squad-question-panel").classList.add("hidden");
    $("squad-results-panel").classList.remove("hidden");
    $("squad-results-bars").classList.add("hidden");
    $("squad-results-freeanswer").classList.add("hidden");
    $("squad-results-challenge").classList.add("hidden");

    // The results payload never repeats the prompt text — it's read back from
    // what activity:question gave us when the round started.
    const prior = currentSquadActivityData || {};
    const promptText = prior.activityId === "would-you-rather" ? `${prior.a} or ${prior.b}` : (prior.text || "");
    $("squad-results-text").textContent = promptText;

    if (data.kind === "poll") {
      $("squad-results-bars").classList.remove("hidden");
      const wrap = $("squad-results-bars");
      wrap.innerHTML = "";
      const tally = [...(data.tally || [])].sort((a, b) => b[1] - a[1]);
      const max = Math.max(1, ...tally.map(([, c]) => c));
      tally.forEach(([label, count]) => {
        const row = document.createElement("div");
        row.className = "result-bar-row";
        row.innerHTML = `
          <div class="result-bar-name" style="width:auto; flex:1; overflow:visible; white-space:normal;">${escapeHtml(label)}</div>
          <div class="result-bar-track" style="max-width:160px;"><div class="result-bar-fill" style="width:0%; background: var(--accent-grad);"><span>${count}</span></div></div>
        `;
        wrap.appendChild(row);
        requestAnimationFrame(() => { row.querySelector(".result-bar-fill").style.width = `${Math.round((count / max) * 100)}%`; });
      });
    } else if (data.kind === "freeAnswer") {
      $("squad-results-freeanswer").classList.remove("hidden");
      const wrap = $("squad-results-freeanswer");
      wrap.innerHTML = "";
      const entry = (data.responses || [])[0];
      if (entry) {
        const [token, value] = entry;
        const p = data.players.find(pp => pp.token === token);
        wrap.innerHTML = `<div class="duo-answer-card"><div class="dac-name"><span class="duo-answer-dot" style="background:${p ? p.color : "#999"};"></span>${escapeHtml(p ? p.nickname : "Someone")}</div><div class="dac-text">${escapeHtml(value)}</div></div>`;
      } else {
        wrap.innerHTML = `<div class="duo-answer-card"><div class="dac-text">No answer this time.</div></div>`;
      }
    } else if (data.kind === "challenge") {
      $("squad-results-challenge").classList.remove("hidden");
      const performer = data.players.find(p => p.token === data.performerToken);
      const badge = $("squad-challenge-verdict-badge");
      badge.className = "duo-match-badge " + (data.verdict === "passed" ? "matched" : "different");
      badge.textContent = (data.verdict === "passed" ? "✅ Passed" : "❌ Failed") + (performer ? ` — ${performer.nickname}` : "");
    }
  });

  socket.on("activity:skipped", () => {
    if (!squadActivityKind) return; // vote-person's own squad:skipped handler covers that case
    squadActivityKind = null;
    currentSquadActivityData = null;
    toast("Host skipped that activity.");
    resetSquadUI();
  });

  // ================= DUO =================
  let duoCategories = [];
  socket.emit("duo:categories", cats => { duoCategories = cats; });

  function resetDuoUI() {
    $("duo-idle").classList.remove("hidden");
    $("duo-question-panel").classList.add("hidden");
    $("duo-results-panel").classList.add("hidden");
  }

  $("btn-duo-ask-match").addEventListener("click", () => {
    if (!duoCategories.length) socket.emit("duo:categories", cats => { duoCategories = cats; renderDuoChips(); });
    else renderDuoChips();
    switchTab("modal-ask-duo-match", "suggested");
    $("duo-custom-a").value = ""; $("duo-custom-b").value = "";
    $("modal-ask-duo-match").classList.remove("hidden");
  });
  function renderDuoChips() {
    const wrap = $("duo-category-chips");
    wrap.innerHTML = "";
    duoCategories.forEach((c, i) => {
      const chip = document.createElement("button");
      chip.className = "chip" + (i === 0 ? " selected" : "");
      chip.textContent = c.label;
      chip.dataset.cat = c.id;
      wrap.appendChild(chip);
    });
    S.duoCategory = duoCategories[0] ? duoCategories[0].id : "mixed";
    wrap.querySelectorAll(".chip").forEach(chip => {
      chip.addEventListener("click", () => {
        wrap.querySelectorAll(".chip").forEach(c => c.classList.remove("selected"));
        chip.classList.add("selected");
        S.duoCategory = chip.dataset.cat;
        $("duo-preview-text").textContent = "A fresh " + chip.textContent + " pick will be sent.";
      });
    });
    $("duo-preview-text").textContent = "A fresh pick will be sent.";
  }
  $("btn-duo-shuffle").addEventListener("click", () => $("duo-preview-text").textContent = "Shuffled — tap Send to reveal.");

  document.querySelectorAll('#modal-ask-duo-match .modal-tab').forEach(tab => {
    tab.addEventListener("click", () => switchTab("modal-ask-duo-match", tab.dataset.tab));
  });
  $("btn-duo-match-cancel").addEventListener("click", () => $("modal-ask-duo-match").classList.add("hidden"));
  $("btn-duo-match-send").addEventListener("click", () => {
    const isCustom = !$("duo-match-custom-tab").classList.contains("hidden");
    if (isCustom) {
      const a = $("duo-custom-a").value.trim(), b = $("duo-custom-b").value.trim();
      if (!a || !b) { toast("Fill in both options."); return; }
      socket.emit("duo:ask", { kind: "match", source: "custom", a, b });
    } else {
      socket.emit("duo:ask", { kind: "match", source: "suggested", category: S.duoCategory || "mixed" });
    }
    $("modal-ask-duo-match").classList.add("hidden");
  });

  $("btn-duo-ask-open").addEventListener("click", () => {
    switchTab("modal-ask-duo-open", "suggested");
    $("duo-open-custom-input").value = "";
    $("modal-ask-duo-open").classList.remove("hidden");
  });
  document.querySelectorAll('#modal-ask-duo-open .modal-tab').forEach(tab => {
    tab.addEventListener("click", () => switchTab("modal-ask-duo-open", tab.dataset.tab));
  });
  document.querySelectorAll('#duo-open-suggested-tab .chip').forEach(chip => {
    chip.addEventListener("click", () => {
      document.querySelectorAll('#duo-open-suggested-tab .chip').forEach(c => c.classList.remove("selected"));
      chip.classList.add("selected");
      S.duoOpenKind = chip.dataset.kind;
      $("duo-open-preview-text").textContent = "A " + chip.textContent + " prompt will be sent.";
    });
  });
  $("btn-duo-open-cancel").addEventListener("click", () => $("modal-ask-duo-open").classList.add("hidden"));
  $("btn-duo-open-send").addEventListener("click", () => {
    const isCustom = !$("duo-open-custom-tab").classList.contains("hidden");
    if (isCustom) {
      const text = $("duo-open-custom-input").value.trim();
      if (!text) { toast("Type a question first."); return; }
      socket.emit("duo:ask", { kind: "open", source: "custom", text });
    } else {
      socket.emit("duo:ask", { kind: "open", source: "suggested", category: S.duoOpenKind });
    }
    $("modal-ask-duo-open").classList.add("hidden");
  });

  $("btn-duo-next").addEventListener("click", () => resetDuoUI());

  let duoTimerInterval;
  socket.on("duo:question", q => {
    $("duo-idle").classList.add("hidden");
    $("duo-results-panel").classList.add("hidden");
    $("duo-question-panel").classList.remove("hidden");
    $("duo-asked-by").textContent = q.askedBy;
    S.selectedDuoChoice = null;
    S.currentDuoQuestion = q;
    renderDuoAnswerStatus([]);

    if (q.kind === "match") {
      $("duo-match-ui").classList.remove("hidden");
      $("duo-open-ui").classList.add("hidden");
      $("duo-option-a").textContent = q.a;
      $("duo-option-b").textContent = q.b;
      $("duo-option-a").classList.remove("selected");
      $("duo-option-b").classList.remove("selected");
      $("duo-option-a").onclick = () => submitDuoChoice(q.id, "a");
      $("duo-option-b").onclick = () => submitDuoChoice(q.id, "b");
      $("duo-progress").textContent = "Waiting on both of you…";
    } else {
      $("duo-match-ui").classList.add("hidden");
      $("duo-open-ui").classList.remove("hidden");
      $("duo-open-text").textContent = q.text;
      $("duo-open-input").value = "";
      $("btn-duo-submit-open").onclick = () => {
        const text = $("duo-open-input").value.trim();
        if (!text) { toast("Write something first."); return; }
        socket.emit("duo:answer", { questionId: q.id, text });
        $("btn-duo-submit-open").disabled = true;
        $("btn-duo-submit-open").textContent = "Answer submitted ✓";
      };
      $("btn-duo-submit-open").disabled = false;
      $("btn-duo-submit-open").textContent = "Submit answer";
      $("duo-progress").textContent = "Waiting on both of you…";
    }

    // Ordinary Duo activities have no visible countdown — pressure doesn't fit
    // "get to know someone." Only timed activities (future speed challenges) show one.
    if (q.timed) {
      $("duo-timer-bar").classList.remove("hidden");
      runTimer($("duo-timer-fill"), q.durationMs, duoTimerInterval, id => duoTimerInterval = id);
    } else {
      $("duo-timer-bar").classList.add("hidden");
      clearInterval(duoTimerInterval);
    }
  });

  // Reconnected mid-question: server resends the question via the normal
  // duo:question handler above, then tells us what we'd already answered (if
  // anything) so the UI can reflect it without re-submitting.
  socket.on("duo:restore-answer", ({ choice, text }) => {
    if (choice) {
      S.selectedDuoChoice = choice;
      $("duo-option-a").classList.toggle("selected", choice === "a");
      $("duo-option-b").classList.toggle("selected", choice === "b");
      $("duo-progress").textContent = "Waiting on the other answer…";
    } else if (text) {
      $("duo-open-input").value = text;
      $("btn-duo-submit-open").disabled = true;
      $("btn-duo-submit-open").textContent = "Answer submitted ✓";
      $("duo-progress").textContent = "Waiting on the other answer…";
    }
  });

  function submitDuoChoice(questionId, choice) {
    S.selectedDuoChoice = choice;
    $("duo-option-a").classList.toggle("selected", choice === "a");
    $("duo-option-b").classList.toggle("selected", choice === "b");
    socket.emit("duo:answer", { questionId, choice });
  }

  socket.on("duo:progress", ({ answered, total, answeredTokens }) => {
    $("duo-progress").textContent = answered >= total ? "Revealing…" : `${answered} of ${total} answered`;
    renderDuoAnswerStatus(answeredTokens || []);
  });

  socket.on("duo:skipped", () => { toast("Host skipped that question."); resetDuoUI(); });

  socket.on("duo:results", data => {
    clearInterval(duoTimerInterval);
    $("duo-question-panel").classList.add("hidden");
    $("duo-results-panel").classList.remove("hidden");
    updateStarsAndFlash(data.players, "duo-stars");

    const badge = $("duo-match-badge");
    if (data.kind === "match") {
      badge.classList.remove("hidden");
      badge.className = "duo-match-badge " + (data.matched ? "matched" : "different");
      badge.textContent = data.matched ? "✨ Match!" : "Different answers";
      $("duo-results-text").textContent = `${data.a} or ${data.b}`;
    } else {
      badge.classList.add("hidden");
      $("duo-results-text").textContent = data.text;
    }

    const wrap = $("duo-answers");
    wrap.innerHTML = "";
    data.answers.forEach(a => {
      const card = document.createElement("div");
      card.className = "duo-answer-card";
      const displayAnswer = data.kind === "match" ? (a.answer === "a" ? data.a : a.answer === "b" ? data.b : "No answer") : (a.answer || "No answer");
      card.innerHTML = `<div class="dac-name"><span class="duo-answer-dot" style="background:${a.color};"></span>${escapeHtml(a.nickname)}</div><div class="dac-text">${escapeHtml(displayAnswer)}</div>`;
      wrap.appendChild(card);
    });
  });

  // ---------------- timer util ----------------
  function runTimer(fillEl, durationMs, existingInterval, setInterval_) {
    clearInterval(existingInterval);
    const start = Date.now();
    fillEl.style.transition = "none";
    fillEl.style.width = "100%";
    requestAnimationFrame(() => { fillEl.style.transition = `width ${durationMs}ms linear`; fillEl.style.width = "0%"; });
    const id = window.setInterval(() => {
      if (Date.now() - start >= durationMs) clearInterval(id);
    }, 250);
    setInterval_(id);
  }

  // ---------------- host controls drawer ----------------
  $("squad-host-controls-btn").addEventListener("click", () => $("drawer-host").classList.remove("hidden"));
  $("squad-host-controls-btn-duo").addEventListener("click", () => $("drawer-host").classList.remove("hidden"));
  $("btn-host-close").addEventListener("click", () => $("drawer-host").classList.add("hidden"));
  $("btn-host-skip").addEventListener("click", () => { socket.emit("safety:skip-question"); $("drawer-host").classList.add("hidden"); });
  $("btn-host-end").addEventListener("click", () => {
    if (confirm("End the session for everyone and show the recap?")) {
      socket.emit("session:end");
      $("drawer-host").classList.add("hidden");
    }
  });

  // ---------------- reactions ----------------
  ["squad-reactions", "duo-reactions"].forEach(barId => {
    const bar = $(barId);
    ["😂","😮","🔥","💯","🤝","👀"].forEach(emoji => {
      const btn = document.createElement("button");
      btn.className = "reaction-btn";
      btn.textContent = emoji;
      btn.addEventListener("click", () => socket.emit("reaction:send", emoji));
      bar.appendChild(btn);
    });
  });
  socket.on("reaction:incoming", ({ emoji }) => {
    const el = document.createElement("div");
    el.className = "floating-reaction";
    el.textContent = emoji;
    el.style.left = `${20 + Math.random() * 60}%`;
    $("reaction-layer").appendChild(el);
    setTimeout(() => el.remove(), 2300);
  });

  // ---------------- typing presence ----------------
  let typingSent = 0;
  function maybeSendTyping() {
    const now = Date.now();
    if (now - typingSent > 1200) { socket.emit("presence:typing"); typingSent = now; }
  }
  ["squad-custom-input", "duo-open-custom-input", "duo-open-input"].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener("input", maybeSendTyping);
  });
  socket.on("presence:typing", ({ nickname }) => {
    $("squad-typing").textContent = `${nickname} is typing…`;
    $("duo-typing").textContent = `${nickname} is typing…`;
  });
  socket.on("presence:stopped-typing", () => {
    $("squad-typing").textContent = "";
    $("duo-typing").textContent = "";
  });

  // ---------------- toasts from server ----------------
  socket.on("toast", ({ text }) => toast(text));
  socket.on("safety:kicked", () => {
    toast("You were removed from the room.");
    localStorage.removeItem("bonga_token");
    setTimeout(() => { window.location.href = window.location.origin; }, 1200);
  });
  socket.on("safety:report-received", ({ target, count }) => {
    toast(`Report received about ${target} (${count} total this session).`);
  });

  // ---------------- recap ----------------
  socket.on("session:recap", data => {
    $("recap-room-name").textContent = data.roomName ? `${data.roomName}.` : "tonight.";
    const cards = $("recap-highlights");
    cards.innerHTML = "";
    const items = [];
    if (data.winner) items.push({ label: "Winner", value: `🏆 ${data.winner.nickname}` });
    if (data.mostVoted) items.push({ label: "Most voted", value: `${data.mostVoted.nickname} (${data.mostVoted.count}×)` });
    if (data.mostActive) items.push({ label: "Most active", value: `⚡ ${data.mostActive.nickname}` });
    if (data.duoMatch) items.push({ label: "Duo matches", value: `${data.duoMatch.matched} / ${data.duoMatch.total}` });
    items.push({ label: "Questions asked", value: String(data.questionsAnswered) });
    items.forEach(it => {
      const c = document.createElement("div");
      c.className = "recap-card";
      c.innerHTML = `<div class="recap-card-label">${it.label}</div><div class="recap-card-value">${escapeHtml(it.value)}</div>`;
      cards.appendChild(c);
    });

    const board = $("recap-leaderboard");
    board.innerHTML = "";
    data.leaderboard.forEach((p, i) => {
      const row = document.createElement("div");
      row.className = "recap-row";
      row.innerHTML = `<span class="recap-rank">#${i + 1}</span><span>${p.avatar}</span><span>${escapeHtml(p.nickname)}</span><span class="recap-score">${p.score} ⭐</span>`;
      board.appendChild(row);
    });

    // Only the host can actually trigger these — everyone else just watches the
    // room state change — but showing/hiding based on host-ness avoids a dead click.
    $("btn-recap-rematch").classList.toggle("hidden", !isHost());
    $("btn-recap-replay").classList.toggle("hidden", !isHost());

    showView("view-recap");
  });
  $("btn-recap-rematch").addEventListener("click", () => { socket.emit("session:rematch"); });
  $("btn-recap-replay").addEventListener("click", () => { socket.emit("session:replay"); });
  socket.on("room:state", room => { if (document.getElementById("view-recap").classList.contains("active") && room.phase === "lobby") { renderRoom(room); showView("view-lobby"); } });
  $("btn-recap-home").addEventListener("click", leaveRoom);

  // ---------------- connection resilience ----------------
  // A raw socket error means nothing to a non-technical player mid-game — show a
  // calm, persistent banner instead of a disappearing toast (section 26).
  let reconnectAttempts = 0;
  function showReconnectBanner(persistent) {
    $("reconnect-banner").classList.remove("hidden");
    $("btn-reconnect-retry").classList.toggle("hidden", !persistent);
    $("reconnect-banner-sub").textContent = persistent
      ? "We couldn't reconnect you."
      : "Trying to reconnect…";
  }
  function hideReconnectBanner() {
    $("reconnect-banner").classList.add("hidden");
    reconnectAttempts = 0;
  }
  socket.on("connect_error", () => showReconnectBanner(false));
  socket.io.on("reconnect_attempt", () => {
    reconnectAttempts++;
    if (reconnectAttempts > 5) showReconnectBanner(true);
  });
  $("btn-reconnect-retry").addEventListener("click", () => {
    reconnectAttempts = 0;
    showReconnectBanner(false);
    socket.connect();
  });
  socket.on("connect", () => { if (reconnectAttempts > 0 || !$("reconnect-banner").classList.contains("hidden")) hideReconnectBanner(); });
  socket.io.on("reconnect", () => {
    hideReconnectBanner();
    if (S.code && myToken()) {
      socket.emit("join-room", { code: S.code, nickname: store.nickname, avatar: store.avatar, token: myToken() }, res => {
        if (res && res.ok) renderRoom(res.room);
      });
    }
  });
})();
