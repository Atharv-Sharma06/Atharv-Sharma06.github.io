import type { ConversationDetail } from '@/analytics/conversations';

type MessageMeta = ConversationDetail['messages'][number];

/**
 * One exchange of a chat: what the user sent, and everything Claude did before the
 * user wrote again. A turn is the natural unit for "how the conversation grew",
 * because the earlier context is re-read once per reply, not once per message.
 */
export interface Turn {
  /** 1-based position in the conversation. */
  turn: number;
  /** When the turn began. */
  at: string | null;
  messages: number;
  /** New content given to the model. */
  input: number;
  /** What the model wrote. */
  output: number;
  /** Earlier context re-sent with the requests of this turn (modelled). */
  replay: number;
  requests: number;
}

/**
 * Groups messages into turns. A new turn starts with a message from the user that
 * follows a message from anyone else; several user messages in a row stay together,
 * and a conversation that opens with Claude gets a first turn without user input.
 */
export function turnsOf(messages: readonly MessageMeta[]): Turn[] {
  const turns: Turn[] = [];
  let previousRole: string | null = null;
  for (const m of messages) {
    let current = turns[turns.length - 1];
    if (!current || (m.role === 'user' && previousRole !== 'user')) {
      current = { turn: turns.length + 1, at: m.at, messages: 0, input: 0, output: 0, replay: 0, requests: 0 };
      turns.push(current);
    }
    current.messages += 1;
    current.input += m.input;
    current.output += m.output;
    current.replay += m.replay;
    current.requests += m.requests;
    previousRole = m.role;
  }
  return turns;
}

const signed = (factor: number) => {
  const pct = Math.round((factor - 1) * 100);
  // U+2212, the minus sign: it has the width of "+" so the two ends of a band line up
  return pct < 0 ? `−${Math.abs(pct)}%` : `+${pct}%`;
};

/**
 * The margin of an estimation method as text: factors 0.88 and 1.12 read "−12% to +12%".
 * A method whose factors are both 1 has no margin.
 */
export function formatBand(lowFactor: number, highFactor: number): string {
  if (!Number.isFinite(lowFactor) || !Number.isFinite(highFactor)) return '–';
  if (Math.round((lowFactor - 1) * 100) === 0 && Math.round((highFactor - 1) * 100) === 0) return 'no margin';
  return `${signed(lowFactor)} to ${signed(highFactor)}`;
}
