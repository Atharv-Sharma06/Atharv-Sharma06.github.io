// Writes the synthetic claude.ai export used by the end-to-end tests:
//   tests/fixtures/claude-export/conversations.json
//   tests/fixtures/claude-export/claude-export-sample.zip   (conversations.json, users.json, projects.json)
// The content is invented; it only follows the shape of a real export. Run with
//   node scripts/make-export-fixture.mjs
import { writeFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';

const ACCOUNT = '00000000-aaaa-4bbb-8ccc-000000000001';
const ROOT = '00000000-0000-4000-8000-000000000000';
const uuid = (c, m) => `${String(c).padStart(8, '0')}-0000-4000-8000-${String(m).padStart(12, '0')}`;
const iso = (ms) => new Date(ms).toISOString().replace('Z', '+00:00').replace(/\.(\d{3})/, '.$1000');

const TOPICS = [
  ['Planning a week in Lisbon', 'I have six days in Lisbon in May. What would a relaxed plan look like?', 'A relaxed week works best if each day has one anchor and the rest stays open. Day one: Alfama on foot, ending at a miradouro for sunset.'],
  ['Fixing a flaky integration test', 'This test fails about one run in ten with a timeout. How do I find out why?', 'Intermittent timeouts usually come from shared state or timing. Start by recording which other tests ran before each failure.'],
  ['Explaining Bayes to a colleague', 'How would you explain Bayes theorem to someone who dislikes formulas?', 'Start with a concrete story about a test that is right most of the time, and count people instead of multiplying probabilities.'],
  ['Sourdough schedule for weekdays', 'I want fresh bread on Saturday morning but I work all week. Suggest a schedule.', 'Feed the starter on Thursday night, mix on Friday evening, shape before bed and proof in the fridge overnight.'],
];

const conversations = [];
let c = 0;
for (let month = 0; month < 14; month++) {
  for (let k = 0; k < 2; k++) {
    c++;
    const [name, question, answer] = TOPICS[(month + k) % TOPICS.length];
    const start = Date.UTC(2025, 2 + month, 3 + k * 9, 9 + k * 5, 12);
    const turns = 2 + ((month + k) % 3);
    const messages = [];
    let parent = ROOT;
    let t = start;
    for (let turn = 0; turn < turns; turn++) {
      const human = uuid(c, turn * 2 + 1);
      const text = turn === 0 ? question : `${question.split('.')[0]}. Can you go deeper on point ${turn}?`;
      messages.push({
        uuid: human, text, content: [{ type: 'text', text, start_timestamp: iso(t), stop_timestamp: iso(t), citations: [] }],
        sender: 'human', created_at: iso(t), updated_at: iso(t), attachments: turn === 0 && k === 1
          ? [{ file_name: 'notes.txt', file_size: 2400, file_type: 'txt', extracted_content: 'Background notes. '.repeat(120) }] : [],
        files: [], parent_message_uuid: parent,
      });
      parent = human;
      t += 20_000;
      const reply = uuid(c, turn * 2 + 2);
      const body = `${answer} ${'Here is some further detail that expands on the idea step by step. '.repeat(6 + turn * 3)}`;
      const content = [];
      if (month >= 6 && turn === 1) content.push({ type: 'thinking', thinking: 'The user wants more depth. Consider the order of the points and what to leave out. '.repeat(5), start_timestamp: iso(t), stop_timestamp: iso(t + 4000) });
      content.push({ type: 'text', text: body, start_timestamp: iso(t + 4000), stop_timestamp: iso(t + 15_000), citations: [] });
      messages.push({ uuid: reply, text: body, content, sender: 'assistant', created_at: iso(t), updated_at: iso(t + 15_000), attachments: [], files: [], parent_message_uuid: parent });
      parent = reply;
      t += 90_000;
    }
    conversations.push({ uuid: uuid(c, 0), name: `${name} (${c})`, summary: '', created_at: iso(start), updated_at: iso(t), account: { uuid: ACCOUNT }, chat_messages: messages });
  }
}

const json = JSON.stringify(conversations);
const dir = new URL('../tests/fixtures/claude-export/', import.meta.url);
writeFileSync(new URL('conversations.json', dir), json);
const users = JSON.stringify([{ uuid: ACCOUNT, full_name: 'Sample Person', email_address: 'sample@example.com', verified_phone_number: null }]);
writeFileSync(new URL('claude-export-sample.zip', dir), zipSync({ 'conversations.json': strToU8(json), 'users.json': strToU8(users), 'projects.json': strToU8('[]') }));
console.log(`wrote ${conversations.length} conversations, ${conversations.reduce((n, x) => n + x.chat_messages.length, 0)} messages`);
