// Casual Talks has no game mechanics at all — no rounds, no responses tracked,
// no scoring. This is just a shuffleable conversation starter any player can
// refresh. Content stays lightweight and broadly inclusive on purpose.

const casualTopics = [
  "What's a small thing that made you smile this week?",
  "What's something you're looking forward to?",
  "What's a show or song everyone should try?",
  "What's a skill you wish you had?",
  "What's the best meal you've had recently?",
  "What's a place you'd love to visit?",
  "What's something you learned recently that stuck with you?",
  "What's a tradition in your family or friend group?",
  "What's your go-to comfort activity after a long day?",
  "If you could instantly master one thing, what would it be?",
  "What's a small win from this week worth celebrating?",
  "What's something you're curious about but haven't looked into yet?",
  "What's a memory that always makes you laugh?",
  "What's a change you've made that you're glad you did?",
  "What's something everyone in this group should know about you?"
];

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getCasualTopic(excludeText) {
  if (casualTopics.length <= 1) return casualTopics[0];
  let topic;
  do { topic = randomFrom(casualTopics); } while (topic === excludeText);
  return topic;
}

module.exports = { getCasualTopic };
