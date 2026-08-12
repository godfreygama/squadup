// Suggested question library.
// Squad questions are "vote for a person in the room" prompts.
// Duo questions are "this or that" / matching prompts answered independently by 2 people.
// "late-night" category intentionally omitted from defaults for safety (see safety notes in README).

const squadQuestions = {
  funny: [
    "Who is most likely to disappear from the group chat for three days?",
    "Who would survive the longest without their phone?",
    "Who is most likely to become famous by accident?",
    "Who would win in a staring contest against a toddler?",
    "Who is most likely to send a text to the wrong person?",
    "Who would forget their own birthday?",
    "Who is most likely to start laughing at the worst possible moment?",
    "Who would get lost trying to find the bathroom in their own house?"
  ],
  savage: [
    "Who would be the worst business partner?",
    "Who is most likely to ghost someone after one date?",
    "Who would sell everyone out for a free vacation?",
    "Who talks the most but says the least?",
    "Who would be voted off the island first?",
    "Who is most likely to take credit for someone else's idea?"
  ],
  deep: [
    "Who in this room has grown the most in the last year?",
    "Who would you trust with a secret you've never told anyone?",
    "Who seems like they're carrying more than they let on?",
    "Who gives the best advice when things go wrong?",
    "Who has changed your life the most without realizing it?"
  ],
  random: [
    "Who would survive longest on a deserted island?",
    "Who is most likely to become a millionaire?",
    "Who would win a zombie apocalypse?",
    "Who is most likely to move to another country?",
    "Who would make the best reality TV star?",
    "Who is most likely to accidentally start a trend?"
  ],
  hypothetical: [
    "If this group started a business together, who would be the CEO?",
    "If we were stranded together, who would take charge?",
    "Who would be the first to call for help in an emergency?",
    "If everyone swapped lives for a day, whose life would be most chaotic?"
  ],
  friendship: [
    "Who gives the best hugs?",
    "Who remembers everyone's birthday without being told?",
    "Who is the glue that holds this group together?",
    "Who would drop everything to help a friend at 2am?",
    "Who has the best taste in music in this group?"
  ]
};

const duoQuestions = {
  funny: [
    { a: "Text first", b: "Wait for them to text first" },
    { a: "Dance in public", b: "Sing in public" },
    { a: "Loud laugh", b: "Silent laugh" },
    { a: "Overshare", b: "Undershare" }
  ],
  savage: [
    { a: "Brutally honest", b: "Kind white lie" },
    { a: "Call them out", b: "Let it slide" },
    { a: "Petty comeback", b: "Ignore it completely" }
  ],
  deep: [
    { a: "Follow your head", b: "Follow your heart" },
    { a: "Be understood", b: "Be admired" },
    { a: "Know the future", b: "Change the past" },
    { a: "Perfect memory", b: "Clean slate" }
  ],
  random: [
    { a: "Beach", b: "Mountains" },
    { a: "City", b: "Countryside" },
    { a: "Morning person", b: "Night owl" },
    { a: "Plan everything", b: "Be spontaneous" },
    { a: "Call", b: "Text" },
    { a: "Stay in", b: "Go out" }
  ],
  hypothetical: [
    { a: "Read minds", b: "See the future" },
    { a: "Fly", b: "Be invisible" },
    { a: "Never need sleep", b: "Never need food" }
  ],
  crush: [
    { a: "Make the first move", b: "Have someone make it" },
    { a: "Slow burn", b: "Love at first sight" },
    { a: "Deep conversation", b: "Shared adventure" }
  ],
  "getting-to-know-you": [
    { a: "Stay in with a movie", b: "Go out and explore" },
    { a: "Small group of friends", b: "Big circle of friends" },
    { a: "Plan the trip", b: "Wing it completely" }
  ]
};

const duoOpenQuestions = {
  "how-well": [
    "What is my ideal holiday?",
    "What's my go-to comfort food?",
    "What would I do with an unexpected free day?",
    "What's a small thing that makes my day better?"
  ],
  "first-impression": [
    "What do you think I noticed about you first?",
    "What was your honest first impression of me?",
    "What do you think I'd say is your best quality?"
  ],
  memory: [
    "Where did we first meet?",
    "What was the first thing we talked about?",
    "What's the funniest thing that happened when we first met?"
  ],
  crush: [
    "What's your idea of a perfect first date?",
    "What makes someone attractive to you?",
    "What's your biggest green flag?",
    "What's an instant turn-off for you?",
    "What's something you notice first about someone?"
  ]
};

const squadCategoryMeta = [
  { id: "funny", label: "Funny", blurb: "Lighthearted questions designed to create laughter." },
  { id: "savage", label: "Savage", blurb: "Playful but more provocative questions." },
  { id: "deep", label: "Deep", blurb: "Questions intended to create meaningful conversation." },
  { id: "random", label: "Random", blurb: "Unexpected questions." },
  { id: "hypothetical", label: "Hypothetical", blurb: "What would you do if...?" },
  { id: "friendship", label: "Friendship", blurb: "Questions about memories and relationships." }
];

const duoCategoryMeta = [
  { id: "random", label: "Random", blurb: "A bit of everything." },
  { id: "funny", label: "Funny", blurb: "Light and playful." },
  { id: "deep", label: "Deep", blurb: "Meaningful, thoughtful picks." },
  { id: "savage", label: "Savage", blurb: "A little spicier." },
  { id: "hypothetical", label: "Hypothetical", blurb: "What-if scenarios." },
  { id: "crush", label: "Crush", blurb: "For people exploring something more." },
  { id: "getting-to-know-you", label: "Getting to Know You", blurb: "Easing in." }
];

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getSquadQuestion(category) {
  const cat = category === "mixed" || !squadQuestions[category]
    ? randomFrom(Object.keys(squadQuestions))
    : category;
  return { text: randomFrom(squadQuestions[cat]), category: cat };
}

function getDuoThisOrThat(category) {
  const cat = category === "mixed" || !duoQuestions[category]
    ? randomFrom(Object.keys(duoQuestions))
    : category;
  const pair = randomFrom(duoQuestions[cat]);
  return { a: pair.a, b: pair.b, category: cat };
}

function getDuoOpen(kind) {
  const bank = duoOpenQuestions[kind] || duoOpenQuestions["how-well"];
  return randomFrom(bank);
}

module.exports = {
  squadQuestions,
  duoQuestions,
  duoOpenQuestions,
  squadCategoryMeta,
  duoCategoryMeta,
  getSquadQuestion,
  getDuoThisOrThat,
  getDuoOpen
};
