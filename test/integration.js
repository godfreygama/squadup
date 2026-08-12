const { io } = require("socket.io-client");

const URL = "http://localhost:3000";
let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ FAIL: ${label}`); }
}

function connect() {
  return io(URL, { transports: ["websocket"], forceNew: true });
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`Timeout waiting for: ${label}`)), ms))
  ]);
}

async function run() {
  console.log("--- Test 1: create + join + squad flow ---");
  const s1 = connect();
  const s2 = connect();
  await new Promise(r => s1.on("connect", r));
  await new Promise(r => s2.on("connect", r));

  const createRes = await new Promise(r => s1.emit("create-room", { nickname: "Alice", avatar: "🙂" }, r));
  check("room created", createRes.ok === true);
  check("room code is 5 chars", createRes.code.length === 5);
  const code = createRes.code;

  const joinRes = await new Promise(r => s2.emit("join-room", { code, nickname: "Bob", avatar: "😎" }, r));
  check("second player joined", joinRes.ok === true);
  check("room has 2 players", joinRes.room.players.length === 2);

  // start squad mode
  const roomStatePromise = new Promise(r => s2.once("room:state", r));
  s1.emit("mode:start", "squad");
  const state = await roomStatePromise;
  check("mode switched to squad", state.mode === "squad" && state.phase === "squad");

  // ask a suggested question
  const q1p1 = new Promise(r => s1.once("squad:question", r));
  const q1p2 = new Promise(r => s2.once("squad:question", r));
  s1.emit("squad:ask", { source: "suggested", category: "funny" });
  const [q1a, q1b] = await Promise.all([q1p1, q1p2]);
  check("both clients received the question", !!q1a.text && q1a.text === q1b.text);
  check("question has 2 target players", q1a.players.length === 2);

  // both vote -> should trigger immediate reveal
  const results1 = new Promise(r => s1.once("squad:results", r));
  const results2 = new Promise(r => s2.once("squad:results", r));
  const aliceToken = q1a.players.find(p => p.nickname === "Alice").token;
  const bobToken = q1a.players.find(p => p.nickname === "Bob").token;
  s1.emit("squad:vote", { questionId: q1a.id, targetToken: bobToken });
  s2.emit("squad:vote", { questionId: q1a.id, targetToken: bobToken });
  const [r1, r2] = await Promise.all([results1, results2]);
  check("results revealed after both voted", r1.results.length > 0);
  const bobResult = r1.results.find(x => x.token === bobToken);
  check("bob received 2 votes", bobResult && bobResult.count === 2);

  console.log("--- Test 2: custom question ---");
  const q2p1 = new Promise(r => s1.once("squad:question", r));
  s1.emit("squad:ask", { source: "custom", text: "Who tells the best jokes?" });
  const q2 = await q2p1;
  check("custom question text passed through", q2.text === "Who tells the best jokes?");

  // let it timeout naturally is slow (30s) -- instead have both vote to trigger reveal
  const resultsCustom = new Promise(r => s1.once("squad:results", r));
  s1.emit("squad:vote", { questionId: q2.id, targetToken: aliceToken });
  s2.emit("squad:vote", { questionId: q2.id, targetToken: aliceToken });
  await resultsCustom;
  check("custom question resolved", true);

  console.log("--- Test 3: duo mode ---");
  const stateP = new Promise(r => s2.once("room:state", r));
  s1.emit("mode:back-to-lobby");
  await stateP;
  const duoStateP = new Promise(r => s2.once("room:state", r));
  s1.emit("mode:start", "duo");
  const duoState = await duoStateP;
  check("mode switched to duo", duoState.mode === "duo");

  const dq1 = new Promise(r => s1.once("duo:question", r));
  const dq2 = new Promise(r => s2.once("duo:question", r));
  s1.emit("duo:ask", { kind: "match", source: "suggested", category: "random" });
  const [dqa, dqb] = await Promise.all([dq1, dq2]);
  check("duo question broadcast to both", dqa.a === dqb.a && dqa.b === dqb.b);

  const dres1 = new Promise(r => s1.once("duo:results", r));
  const dres2 = new Promise(r => s2.once("duo:results", r));
  s1.emit("duo:answer", { questionId: dqa.id, choice: "a" });
  s2.emit("duo:answer", { questionId: dqa.id, choice: "a" });
  const [dr1] = await Promise.all([dres1, dres2]);
  check("duo match detected when both pick same option", dr1.matched === true);

  console.log("--- Test 4: session end / recap ---");
  const recapP = new Promise(r => s2.once("session:recap", r));
  s1.emit("session:end");
  const recap = await recapP;
  check("recap includes leaderboard", Array.isArray(recap.leaderboard) && recap.leaderboard.length === 2);
  check("recap includes duo match stats", recap.duoMatch && recap.duoMatch.matched === 1);

  console.log("--- Test 5: reconnection ---");
  const token1 = createRes.token;
  s1.close(); // simulate real client: old connection drops before the reconnect happens
  await new Promise(r => setTimeout(r, 200));
  const s1b = connect();
  await new Promise(r => s1b.on("connect", r));
  const rejoin = await new Promise(r => s1b.emit("join-room", { code, nickname: "Alice", token: token1 }, r));
  check("reconnect with existing token succeeds", rejoin.ok === true && rejoin.rejoined === true);
  check("score persisted across reconnect", rejoin.room.players.find(p => p.nickname === "Alice").score > 0);

  console.log("--- Test 6: safety - report and kick ---");
  let reportReceivedOnHost = new Promise(r => s1b.once("safety:report-received", r));
  s2.emit("safety:report", { targetToken: aliceToken, reason: "testing report flow" });
  const reportEvt = await reportReceivedOnHost;
  check("host notified of report", reportEvt.count === 1);

  const kickedP = new Promise(r => s2.once("safety:kicked", r));
  s1b.emit("safety:kick", bobToken);
  await kickedP;
  check("kicked player receives kicked event", true);

  s1b.close(); s2.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

const hardTimeout = setTimeout(() => { console.error("HARD TIMEOUT — a test hung"); process.exit(1); }, 20000);
run().then(() => clearTimeout(hardTimeout)).catch(err => { console.error("Test run crashed:", err); process.exit(1); });
