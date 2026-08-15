// The activity catalog. Adding a new game to BONGA should mean adding an entry
// here (plus prompt content below), not writing new server event handlers.
//
// responseMode is one of:
//   'poll'        - everyone (or a subset) picks one option. Options are either
//                   every player in the room ('players') or a fixed list ('fixed').
//                   If answerKey is 'target', one player's pick is treated as the
//                   correct answer and others are scored against it. Otherwise
//                   it's a plain tally (system-verified either way, never a human
//                   judgment call).
//   'freeAnswer'  - one, some, or all players type a response. Never scored by
//                   the system — these are conversational by nature (Truth,
//                   Hot Seat, Duo's Open Question).
//   'challenge'   - a performer attempts something and self-reports. The current
//                   rotating Judge decides pass/fail — the only responseMode that
//                   needs a human verification step, because there's no
//                   algorithmic way to check a dare.
//   'conversation'- a prompt is shown, nobody responds, nothing is scored. Purely
//                   a beat, not a round (reserved for future use, not wired to a
//                   catalog entry yet).
//
// target: how the target/performer is chosen, for activities that need one:
//   'spotlight'   - the room's shared rotation queue picks the next player
//   'both'        - Duo only; both players always participate, no single target
//   null          - no target concept (e.g. Squad's players-poll activities)

const activityCatalog = {
  // ---- Squad: existing "Who Knows Who?" behavior, unchanged ----
  "vote-person": {
    label: "Who Knows Who?",
    mode: "squad",
    responseMode: "poll",
    options: "players",
    answerKey: "none",
    target: null,
    requiredResponders: "all",
    scoring: { participation: 1, topVoted: 5 }
  },

  // ---- Squad: new poll-based activities (near-zero new code, catalog only) ----
  "most-likely-to": {
    label: "Most Likely To",
    mode: "squad",
    responseMode: "poll",
    options: "players",
    answerKey: "none",
    target: null,
    requiredResponders: "all",
    scoring: { participation: 1, topVoted: 5 }
  },
  "never-have-i-ever": {
    label: "Never Have I Ever",
    mode: "squad",
    responseMode: "poll",
    options: "fixed",
    fixedOptions: ["Have", "Haven't"],
    answerKey: "none",
    target: null,
    requiredResponders: "all",
    scoring: { participation: 1 }
  },
  "would-you-rather": {
    label: "Would You Rather",
    mode: "squad",
    responseMode: "poll",
    options: "fixed",
    fixedOptions: null, // supplied per-question (a/b), like Duo's this-or-that
    answerKey: "none",
    target: null,
    requiredResponders: "all",
    scoring: { participation: 1 }
  },
  // NOTE: "Two Truths and a Lie" and "Guess Who" are intentionally not in this
  // catalog yet. Both need an answerKey:'target' comparison (score a guesser
  // against the target's own submitted answer) that startRound()/resolvePollTally()
  // in server.js don't implement — adding the catalog entry without that logic
  // would create a button that silently does nothing when tapped. Real next step,
  // not a trap for later.

  // ---- Squad: freeAnswer activities ----
  "truth": {
    label: "Truth",
    mode: "squad",
    responseMode: "freeAnswer",
    target: "spotlight",
    requiredResponders: "target-only",
    verification: "none",
    scoring: { participation: 2 }
  },
  "hot-seat": {
    label: "Hot Seat",
    mode: "squad",
    responseMode: "freeAnswer",
    target: "spotlight",
    seatPersists: true,
    requiredResponders: "target-only",
    verification: "none",
    scoring: { participation: 2 }
  },

  // ---- Squad: challenge activity ----
  "dare": {
    label: "Dare",
    mode: "squad",
    responseMode: "challenge",
    target: "spotlight", // the performer
    verification: "judge",
    scoring: { passed: 5, failed: -2 }
  },

  // ---- Duo: existing behavior, unchanged ----
  "match": {
    label: "This or That",
    mode: "duo",
    responseMode: "poll",
    options: "fixed",
    fixedOptions: null, // supplied per-question (a/b)
    answerKey: "none",
    target: "both",
    requiredResponders: "all",
    scoring: { bothMatched: 3, participation: 1 }
  },
  "open-question": {
    label: "Open Question",
    mode: "duo",
    responseMode: "freeAnswer",
    target: "both",
    requiredResponders: "all",
    verification: "none",
    scoring: { participation: 1 }
  }
};

// ---- Prompt content for the new activities. Existing squad/duo question
// libraries (data/questions.js) are untouched and still power vote-person,
// match, and open-question. ----

const truthPrompts = [
  "What's something people misunderstand about you?",
  "What's your most embarrassing moment?",
  "What would you do if you had unlimited money?",
  "What's a rule you've broken on purpose?",
  "What's something you've never told this group?",
  "What's the last lie you told?",
  "What's a habit you're trying to break?"
];

const hotSeatPrompts = [
  "What's a decision you're still not sure was right?",
  "What's something you'd do differently if you started over?",
  "Who in this room do you think understands you best?",
  "What's a compliment you've never said out loud?",
  "What's something you're proud of that you rarely mention?"
];

const darePrompts = [
  "Do an impression of someone in the group.",
  "Text the last person you messaged something random the group chooses.",
  "Speak in an accent for the next two rounds.",
  "Let the group pick your profile picture for a day.",
  "Do your best dance move, no music.",
  "Send a voice note singing happy birthday to no one in particular."
];

const neverHaveIEverPrompts = [
  "Never have I ever pretended to be sick to skip something.",
  "Never have I ever forgotten someone's name right after meeting them.",
  "Never have I ever stalked someone's social media before meeting them.",
  "Never have I ever laughed at the wrong moment.",
  "Never have I ever eaten food that fell on the floor.",
  "Never have I ever pretended to like a gift."
];

const wouldYouRatherPrompts = [
  { a: "Always be 10 minutes late", b: "Always be 20 minutes early" },
  { a: "Read minds", b: "Predict the future" },
  { a: "Lose your phone for a week", b: "Lose your wallet for a week" },
  { a: "Be famous but broke", b: "Be rich but unknown" },
  { a: "Never eat your favorite food again", b: "Only eat your favorite food forever" }
];

function randomFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

module.exports = {
  activityCatalog,
  getTruthPrompt: () => randomFrom(truthPrompts),
  getHotSeatPrompt: () => randomFrom(hotSeatPrompts),
  getDarePrompt: () => randomFrom(darePrompts),
  getNeverHaveIEverPrompt: () => randomFrom(neverHaveIEverPrompts),
  getWouldYouRatherPrompt: () => randomFrom(wouldYouRatherPrompts)
};
