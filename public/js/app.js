(() => {
  "use strict";

  const socket = io();
  const AVATARS = ["🙂","😎","🥳","🤠","🦄","🐸","🔥","👑","🎧","🌈","🦊","🐼","🧃","🍕","👻","🤖"];

  // ---------------- persisted identity ----------------
  const store = {
    get token() { return localStorage.getItem("squadup_token"); },
    set token(v) { localStorage.setItem("squadup_token", v); },
    get nickname() { return localStorage.getItem("squadup_nickname") || ""; },
    set nickname(v) { localStorage.setItem("squadup_nickname", v); },
    get avatar() { return localStorage.getItem("squadup_avatar") || AVATARS[0]; },
    set avatar(v) { localStorage.setItem("squadup_avatar", v); },
    get lastRoom() { return localStorage.getItem("squadup_last_room") || ""; },
    set lastRoom(v) { localStorage.setItem("squadup_last_room", v); }
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

  // ---------------- room name edit ----------------
  $("room-name").addEventListener("blur", () => {
    if (isHost()) socket.emit("room:rename", $("room-name").textContent);
  });
  $("room-name").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); $("room-name").blur(); } });

  // ---------------- share / copy ----------------
  function shareRoom() {
    const url = `${window.location.origin}/?room=${S.code}`;
    if (navigator.share) {
      navigator.share({ title: `Join ${S.room.name} on SquadUp`, text: `Join my room "${S.room.name}" — code ${S.code}`, url }).catch(() => {});
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
    localStorage.removeItem("squadup_token");
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

  function resetSquadUI() {
    $("squad-idle").classList.remove("hidden");
    $("squad-question-panel").classList.add("hidden");
    $("squad-results-panel").classList.add("hidden");
  }

  $("btn-squad-ask").addEventListener("click", openSquadModal);
  $("btn-squad-next").addEventListener("click", openSquadModal);

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

  let squadTimerInterval;
  socket.on("squad:question", q => {
    $("squad-idle").classList.add("hidden");
    $("squad-results-panel").classList.add("hidden");
    $("squad-question-panel").classList.remove("hidden");
    $("squad-asked-by").textContent = q.askedBy;
    $("squad-question-text").textContent = q.text;
    $("squad-progress").textContent = `0 of ${q.players.length} answered`;
    S.selectedVoteTarget = null;

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

  socket.on("squad:progress", ({ answered, total }) => {
    $("squad-progress").textContent = `${answered} of ${total} answered`;
  });

  socket.on("squad:skipped", () => { toast("Host skipped that question."); resetSquadUI(); });

  socket.on("squad:results", data => {
    clearInterval(squadTimerInterval);
    $("squad-question-panel").classList.add("hidden");
    $("squad-results-panel").classList.remove("hidden");
    $("squad-results-text").textContent = data.text;

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

    runTimer($("duo-timer-fill"), q.durationMs, duoTimerInterval, id => duoTimerInterval = id);
  });

  function submitDuoChoice(questionId, choice) {
    S.selectedDuoChoice = choice;
    $("duo-option-a").classList.toggle("selected", choice === "a");
    $("duo-option-b").classList.toggle("selected", choice === "b");
    socket.emit("duo:answer", { questionId, choice });
  }

  socket.on("duo:progress", ({ answered, total }) => {
    $("duo-progress").textContent = answered >= total ? "Revealing…" : `${answered} of ${total} answered`;
  });

  socket.on("duo:skipped", () => { toast("Host skipped that question."); resetDuoUI(); });

  socket.on("duo:results", data => {
    clearInterval(duoTimerInterval);
    $("duo-question-panel").classList.add("hidden");
    $("duo-results-panel").classList.remove("hidden");

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
    localStorage.removeItem("squadup_token");
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
    if (data.mostVoted) items.push({ label: "Most voted", value: `${data.mostVoted.nickname} (${data.mostVoted.count}×)` });
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
      row.innerHTML = `<span class="recap-rank">#${i + 1}</span><span>${p.avatar}</span><span>${escapeHtml(p.nickname)}</span><span class="recap-score">${p.score} pts</span>`;
      board.appendChild(row);
    });

    showView("view-recap");
  });
  $("btn-recap-replay").addEventListener("click", () => { socket.emit("session:replay"); });
  socket.on("room:state", room => { if (document.getElementById("view-recap").classList.contains("active") && room.phase === "lobby") { renderRoom(room); showView("view-lobby"); } });
  $("btn-recap-home").addEventListener("click", leaveRoom);

  // ---------------- connection resilience ----------------
  socket.on("connect_error", () => toast("Connection trouble — retrying…"));
  socket.io.on("reconnect", () => {
    if (S.code && myToken()) {
      socket.emit("join-room", { code: S.code, nickname: store.nickname, avatar: store.avatar, token: myToken() }, res => {
        if (res && res.ok) renderRoom(res.room);
      });
    }
  });
})();
