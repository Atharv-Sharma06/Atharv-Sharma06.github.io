import { CLAUDE3_FROM, DEFAULT_CONTEXT_WINDOW, METHODS, NEW_TOKENIZER_FROM, methodKeyFor, type CatalogMethod } from '@/core/catalog';
import { Limitation } from '@/core/limitations';
import { Sha256, sha256Hex } from '@/core/sha256';
import {
  ImportError,
  type ImportFile,
  type ImportParser,
  type ImportSink,
  type ParseContext,
  type ParsedImport,
  type ParseWarning,
  type StagedMessage,
} from '@/core/types';
import { importFileName, sameArchive } from '../archive';
import { iterateJsonArray } from '../util/json-array-stream';
import { looksLikeZip, openZipEntry, readZipDirectory } from '../util/zip';
import { accountConversation, type AccountBlock, type AccountMessage } from './accounting';

/**
 * Importer for the official claude.ai data export (Settings > Privacy > Export data).
 *
 * Input: the export ZIP (any of its layouts), one of the ZIP parts of a manifest-style
 * export, or an extracted `conversations.json`. The file is a single JSON array that
 * can be very large, so it is streamed one conversation at a time.
 *
 * What the export does and does not contain (verified against real exports from
 * 2025 and 2026 and Anthropic's help centre, see docs/DATA-LIMITATIONS.md):
 *  - message text, thinking, tool calls and tool results, attachment text: yes
 *  - which model answered: no — so the model stays unknown and no model is inferred
 *  - token counts: no — every figure produced here is an estimate
 *  - branches (edits, retries): only in exports made from about June 2026
 *    (`parent_message_uuid`); older exports list messages without tree information
 *  - uploaded images and PDFs: file names only
 *
 * Message text is used to count characters and estimate tokens and is then dropped.
 */
export const CLAUDE_EXPORT_PARSER_VERSION = 'claude-export-1';

const MIN_TIME = Date.UTC(2021, 0, 1);

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function parseTime(value: unknown, maxMs: number): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms < MIN_TIME || ms > maxMs) return null;
  return ms;
}

const FACTOR = new Map<CatalogMethod['basis'], number>(METHODS.map((m) => [m.basis, Number(m.centralFactor)]));
const CLAUDE3_FROM_MS = Date.parse(`${CLAUDE3_FROM}T00:00:00Z`);
const NEW_TOKENIZER_FROM_MS = Date.parse(`${NEW_TOKENIZER_FROM}T00:00:00Z`);

/**
 * The export does not name the model, so the tokenizer generation is taken from the
 * date alone: only the generations that existed on that day are possible.
 */
export function basisForDate(ms: number): CatalogMethod['basis'] {
  if (ms < CLAUDE3_FROM_MS) return 'claude2';
  if (ms < NEW_TOKENIZER_FROM_MS) return 'claude3';
  return 'mixed';
}

interface Normalised {
  id: string;
  parentId: string | null | undefined;
  role: 'user' | 'assistant' | 'other';
  rawTimeMs: number | null;
  endMs: number | null;
  blocks: AccountBlock[];
  textChars: number;
  thinkingChars: number;
  toolChars: number;
  attachmentChars: number;
  attachmentBase: number;
  attachmentCount: number;
  fileCount: number;
  flags: number;
}

interface Tally {
  conversations: number;
  /** Records that are not conversation objects at all. */
  unrecognised: number;
  emptyConversations: number;
  conversationsWithoutId: number;
  conversationsWithoutTime: number;
  messages: number;
  userMessages: number;
  assistantMessages: number;
  invalidTimestamps: number;
  messagesWithoutId: number;
  thinkingBlocks: number;
  toolCalls: number;
  attachments: number;
  binaryFiles: number;
  unknownBlocks: Map<string, number>;
  hasParentPointers: boolean;
  conversationsWithoutPointers: number;
  branchedConversations: number;
  cappedMessages: number;
  accounts: Map<string, number>;
  firstMs: number;
  lastMs: number;
}

export function createClaudeExportParser(countTokens: (text: string) => number): ImportParser {
  const count = (text: string) => (text.length === 0 ? 0 : countTokens(text));

  function toolResultText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return content === null || content === undefined ? '' : JSON.stringify(content);
    let out = '';
    for (const item of content) {
      if (typeof item === 'string') out += item;
      else if (isObject(item)) {
        // What the model receives from a tool: the text, plus title and address for web results.
        if (item.type === 'text') out += str(item.text);
        else if (item.type === 'knowledge') out += `${str(item.title)}\n${str(item.url)}\n${str(item.text)}`;
        else if (typeof item.text === 'string') out += item.text;
        else out += JSON.stringify(item);
      }
      out += '\n';
    }
    return out;
  }

  function normalise(raw: Json, index: number, nowMs: number, tally: Tally): Normalised {
    const sender = str(raw.sender);
    const role: Normalised['role'] = sender === 'human' ? 'user' : sender === 'assistant' ? 'assistant' : 'other';
    const n: Normalised = {
      id: str(raw.uuid),
      parentId: typeof raw.parent_message_uuid === 'string' ? raw.parent_message_uuid : raw.parent_message_uuid === null ? null : undefined,
      role,
      rawTimeMs: parseTime(raw.created_at, nowMs),
      endMs: null,
      blocks: [],
      textChars: 0,
      thinkingChars: 0,
      toolChars: 0,
      attachmentChars: 0,
      attachmentBase: 0,
      attachmentCount: 0,
      fileCount: 0,
      flags: Limitation.MODEL_UNKNOWN | Limitation.HIDDEN_CONTEXT_EXCLUDED,
    };

    const content = Array.isArray(raw.content) ? raw.content : [];
    let sawBlock = false;
    for (const b of content) {
      if (!isObject(b)) continue;
      const type = str(b.type);
      const stop = parseTime(b.stop_timestamp, nowMs);
      if (stop !== null && (n.endMs === null || stop > n.endMs)) n.endMs = stop;
      // When the model began this block: the moment the request that produced it was answered.
      const begun = parseTime(b.start_timestamp, nowMs);
      const startMs = begun === null ? undefined : begun;
      if (type === 'text' || type === 'voice_note') {
        const text = str(b.text);
        n.textChars += text.length;
        if (text.length) n.blocks.push({ kind: 'text', base: count(text), startMs });
        sawBlock = true;
      } else if (type === 'thinking') {
        const text = str(b.thinking);
        n.thinkingChars += text.length;
        if (text.length) n.blocks.push({ kind: 'thinking', base: count(text), startMs });
        n.flags |= Limitation.THINKING_PARTIAL;
        tally.thinkingBlocks++;
        sawBlock = true;
      } else if (type === 'tool_use') {
        const text = `${str(b.name)} ${JSON.stringify(b.input ?? {})}`;
        n.toolChars += text.length;
        n.blocks.push({ kind: 'tool_use', base: count(text), startMs });
        n.flags |= Limitation.TOOL_OVERHEAD_EXCLUDED;
        tally.toolCalls++;
        sawBlock = true;
      } else if (type === 'tool_result') {
        const text = toolResultText(b.content);
        n.toolChars += text.length;
        n.blocks.push({ kind: 'tool_result', base: count(text) });
        n.flags |= Limitation.TOOL_OVERHEAD_EXCLUDED;
        sawBlock = true;
      } else if (type === 'token_budget' || type === 'flag') {
        // markers without content
      } else {
        tally.unknownBlocks.set(type || '(no type)', (tally.unknownBlocks.get(type || '(no type)') ?? 0) + 1);
      }
    }
    // Exports always carry `content`; `text` is a lossy flattening of it and only a fallback.
    if (!sawBlock) {
      const text = str(raw.text);
      n.textChars += text.length;
      if (text.length) n.blocks.push({ kind: 'text', base: count(text) });
    }

    const attachmentNames = new Set<string>();
    if (Array.isArray(raw.attachments)) {
      for (const a of raw.attachments) {
        if (!isObject(a)) continue;
        n.attachmentCount++;
        tally.attachments++;
        if (typeof a.file_name === 'string' && a.file_name) attachmentNames.add(a.file_name);
        const extracted = str(a.extracted_content);
        if (extracted.length === 0) n.flags |= Limitation.ATTACHMENT_TEXT_MISSING;
        n.attachmentChars += extracted.length;
        n.attachmentBase += count(extracted);
      }
    }
    if (Array.isArray(raw.files)) {
      for (const f of raw.files) {
        // The same upload can be listed as an attachment (with text) and as a file.
        const name = isObject(f) ? str(f.file_name) : '';
        if (name && attachmentNames.has(name)) continue;
        n.fileCount++;
        tally.binaryFiles++;
      }
    }
    if (n.fileCount > 0) n.flags |= Limitation.BINARY_FILES_EXCLUDED;

    if (!n.id) {
      // No message id: derive a stable one from what identifies the message.
      n.id = `h:${sha256Hex(`${sender}|${str(raw.created_at)}|${index}|${n.textChars}|${n.toolChars}|${str(raw.text).slice(0, 200)}`).slice(0, 32)}`;
      tally.messagesWithoutId++;
    }
    return n;
  }

  async function handleConversation(raw: unknown, sink: ImportSink, nowMs: number, tally: Tally): Promise<void> {
    if (!isObject(raw) || !Array.isArray(raw.chat_messages)) {
      tally.unrecognised++;
      return;
    }
    const rawMessages = raw.chat_messages.filter(isObject);
    const messages = rawMessages.map((m, i) => normalise(m, i, nowMs, tally));

    const hasContent = messages.some((m) => m.blocks.length > 0 || m.attachmentBase > 0 || m.fileCount > 0);
    if (!hasContent) {
      // Emptied "ghost" conversations (typically deleted ones) carry nothing to count.
      tally.emptyConversations++;
      return;
    }

    const createdMs = parseTime(raw.created_at, nowMs);
    const updatedMs = parseTime(raw.updated_at, nowMs);

    // Messages without a usable timestamp take the nearest known one.
    const times: Array<number | null> = messages.map((m) => m.rawTimeMs);
    let last: number | null = null;
    for (let i = 0; i < times.length; i++) {
      if (times[i] !== null) last = times[i];
      else if (last !== null) times[i] = last;
    }
    let next: number | null = null;
    for (let i = times.length - 1; i >= 0; i--) {
      if (messages[i].rawTimeMs !== null) next = messages[i].rawTimeMs;
      else if (times[i] === null) times[i] = next ?? createdMs ?? updatedMs;
    }
    if (times.some((t) => t === null)) {
      tally.conversationsWithoutTime++;
      return;
    }

    let uuid = str(raw.uuid);
    if (!uuid) {
      uuid = `h:${sha256Hex(`${str(raw.name)}|${str(raw.created_at)}|${messages.map((m) => m.id).join(',')}`).slice(0, 32)}`;
      tally.conversationsWithoutId++;
    }
    const account = isObject(raw.account) ? str(raw.account.uuid) : '';
    if (account) tally.accounts.set(account, (tally.accounts.get(account) ?? 0) + 1);

    const pointers = messages.some((m) => typeof m.parentId === 'string');
    if (pointers) tally.hasParentPointers = true;
    else tally.conversationsWithoutPointers++;

    const accountInput: AccountMessage[] = messages.map((m, i) => {
      const timeMs = times[i] as number;
      return {
        id: m.id,
        parentId: pointers ? (m.parentId ?? null) : undefined,
        role: m.role,
        timeMs,
        endMs: m.endMs !== null && m.endMs >= timeMs ? m.endMs : undefined,
        blocks: m.blocks,
        attachmentBase: m.attachmentBase,
        capBase: Math.floor(DEFAULT_CONTEXT_WINDOW / (FACTOR.get(basisForDate(timeMs)) ?? 1)),
      };
    });
    const accounted = accountConversation(accountInput);

    const key = `claude_ai:${uuid}`;
    let first = Infinity;
    let latest = -Infinity;
    let branched = false;
    if (pointers) {
      const children = new Map<string, number>();
      for (const m of messages) if (typeof m.parentId === 'string') children.set(m.parentId, (children.get(m.parentId) ?? 0) + 1);
      for (const c of children.values()) if (c > 1) branched = true;
    }

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const a = accounted[i];
      const timeMs = times[i] as number;
      first = Math.min(first, timeMs);
      latest = Math.max(latest, m.endMs !== null && m.endMs >= timeMs ? m.endMs : timeMs);
      let flags = m.flags | a.flags;
      if (m.rawTimeMs === null) {
        flags |= Limitation.TIMESTAMP_INFERRED;
        tally.invalidTimestamps++;
      }
      if (a.flags & Limitation.CONTEXT_CAPPED) tally.cappedMessages++;
      if (a.flags & Limitation.BRANCHES_LINEARISED) branched = true;
      const staged: StagedMessage = {
        conversationKey: key,
        externalId: m.id,
        parentExternalId: typeof m.parentId === 'string' ? m.parentId : null,
        role: m.role,
        createdAt: m.rawTimeMs === null ? null : new Date(m.rawTimeMs).toISOString(),
        occurredAt: new Date(timeMs).toISOString(),
        ordinal: i,
        modelKey: null,
        textChars: m.textChars,
        thinkingChars: m.thinkingChars,
        toolChars: m.toolChars,
        attachmentChars: m.attachmentChars,
        attachmentCount: m.attachmentCount,
        fileCount: m.fileCount,
        inputBase: a.inputBase,
        outputBase: a.outputBase,
        replayBase: a.replayBase,
        replayCachedBase: a.replayCachedBase,
        requestCount: a.requestCount,
        methodKey: methodKeyFor(basisForDate(timeMs)),
        limitationFlags: flags,
      };
      await sink.message(staged);
      tally.messages++;
      if (m.role === 'user') tally.userMessages++;
      else if (m.role === 'assistant') tally.assistantMessages++;
    }
    if (branched) tally.branchedConversations++;

    const title = str(raw.name).trim();
    await sink.conversation({
      dedupKey: key,
      kind: 'chat',
      externalId: uuid,
      title: title === '' ? null : title.slice(0, 500),
      projectLabel: null,
      modelKey: null,
      createdAt: new Date(Math.min(createdMs ?? first, first)).toISOString(),
      updatedAt: new Date(Math.max(updatedMs ?? latest, latest)).toISOString(),
      metadata: { branched, hasBranchInfo: pointers },
    });
    tally.conversations++;
    tally.firstMs = Math.min(tally.firstMs, first);
    tally.lastMs = Math.max(tally.lastMs, latest);
  }

  return {
    async parse(files: ImportFile[], sink: ImportSink, ctx: ParseContext): Promise<ParsedImport> {
      if (files.length === 0) throw new ImportError('No file was selected.', 'no_files');
      // Timestamps later than tomorrow are treated as invalid.
      const nowMs = (typeof ctx.options?.now === 'number' ? ctx.options.now : Date.now()) + 86_400_000;

      const tally: Tally = {
        conversations: 0, unrecognised: 0, emptyConversations: 0, conversationsWithoutId: 0, conversationsWithoutTime: 0,
        messages: 0, userMessages: 0, assistantMessages: 0, invalidTimestamps: 0, messagesWithoutId: 0,
        thinkingBlocks: 0, toolCalls: 0, attachments: 0, binaryFiles: 0, unknownBlocks: new Map(),
        hasParentPointers: false, conversationsWithoutPointers: 0, branchedConversations: 0, cappedMessages: 0,
        accounts: new Map(), firstMs: Infinity, lastMs: -Infinity,
      };

      // Every input (ZIP or JSON) contributes zero or more conversations.json streams.
      interface Part { label: string; size: number; open: () => Promise<ReadableStream<Uint8Array>> }
      const parts: Part[] = [];
      const seenInArchives: string[] = [];
      for (const file of files) {
        const head = new Uint8Array(await file.blob.slice(0, 4).arrayBuffer());
        if (looksLikeZip(head)) {
          const entries = await readZipDirectory(file.blob);
          for (const e of entries) if (!e.isDirectory) seenInArchives.push(e.name);
          for (const e of entries) {
            if (e.isDirectory) continue;
            const base = e.name.split('/').pop() ?? e.name;
            if (/^conversations(?:[-_.]\d+)?\.json$/i.test(base)) {
              parts.push({ label: `${file.name} › ${e.name}`, size: e.uncompressedSize, open: () => openZipEntry(file.blob, e) });
            }
          }
        } else {
          parts.push({ label: file.name, size: file.size, open: async () => file.blob.stream() as ReadableStream<Uint8Array> });
        }
      }
      if (parts.length === 0) {
        const listed = seenInArchives.slice(0, 8).join(', ');
        throw new ImportError(
          `The archive does not contain a conversations.json file${listed ? ` (it contains: ${listed}${seenInArchives.length > 8 ? ', …' : ''})` : ''}. ` +
            'If your export arrived as several ZIP parts, choose the one named "conversations".',
          'no_conversations_file',
        );
      }

      const totalBytes = parts.reduce((s, p) => s + p.size, 0);
      let bytesRead = 0;
      let records = 0;
      let truncated = false;
      let trailingData = false;
      const hash = new Sha256();

      for (const part of parts) {
        if (ctx.signal?.aborted) throw new ImportError('The import was cancelled.', 'cancelled');
        const stream = await part.open();
        let lastReport = 0;
        const elements = iterateJsonArray(stream, {
          onBytes: (chunk) => {
            bytesRead += chunk.length;
            hash.update(chunk);
          },
          onEnd: (info) => {
            if (info.truncated) truncated = true;
            if (info.trailingData) trailingData = true;
          },
        });
        try {
          for await (const element of elements) {
            records++;
            await handleConversation(element, sink, nowMs, tally);
            if (bytesRead - lastReport > 4_000_000) {
              lastReport = bytesRead;
              sink.progress?.({ phase: 'Reading conversations', bytesRead, totalBytes, records });
              if (ctx.signal?.aborted) throw new ImportError('The import was cancelled.', 'cancelled');
            }
          }
        } catch (err) {
          if (err instanceof ImportError && err.code === 'not_a_json_array') {
            throw new ImportError(
              `"${part.label}" is not a claude.ai conversations export: it should be a JSON list of conversations.`,
              'not_a_conversations_export',
            );
          }
          throw err;
        }
      }
      sink.progress?.({ phase: 'Reading conversations', bytesRead, totalBytes, records });

      if (tally.conversations === 0) {
        if (records > 0 && tally.unrecognised === records) {
          throw new ImportError(
            'The file is a JSON list, but its records do not look like claude.ai conversations (no "chat_messages" with content).',
            'not_a_conversations_export',
          );
        }
        if (records === 0 && truncated) {
          // Cut off before the first conversation was complete: the file is damaged, not empty.
          throw new ImportError(
            'The file ends in the middle of its first conversation, so nothing could be read. The download or copy was probably cut short. Download the export again and choose the new file.',
            'truncated_file',
          );
        }
        if (records === 0) throw new ImportError('The export contains no conversations.', 'empty_export');
      }

      const warnings: ParseWarning[] = [];
      if (truncated) {
        warnings.push({
          code: 'truncated_file',
          message: 'The file ends unexpectedly. Complete conversations were read; the last one was cut off. Download the export again to be sure nothing is missing.',
          count: 1,
        });
      }
      if (trailingData) {
        warnings.push({
          code: 'trailing_data',
          message:
            'The file continues after the end of its list of conversations, for example because a second export was appended to it. Only the first list was read. Import the other export as its own file.',
          count: 1,
        });
      }
      if (tally.accounts.size > 1) {
        const counts = [...tally.accounts.values()].sort((a, b) => b - a);
        warnings.push({
          code: 'several_accounts',
          message:
            'accounts appear in this file. All of their conversations are imported together, under one source, and count as one history. ' +
            'If the file holds other people’s conversations (an organisation export, or exports joined together), their usage is part of every total.',
          count: tally.accounts.size,
          sample: `Conversations per account: ${counts.slice(0, 8).join(', ')}${counts.length > 8 ? ', …' : ''}`,
        });
      }
      if (tally.invalidTimestamps > 0) {
        warnings.push({
          code: 'invalid_timestamp',
          message: 'Some messages had a missing or invalid timestamp. The nearest valid timestamp in the same conversation was used.',
          count: tally.invalidTimestamps,
        });
      }
      if (tally.conversationsWithoutTime > 0) {
        warnings.push({
          code: 'no_valid_timestamps',
          message: 'Some conversations had no usable timestamp at all and were skipped, because they cannot be placed on the timeline.',
          count: tally.conversationsWithoutTime,
        });
      }
      if (tally.emptyConversations > 0) {
        warnings.push({
          code: 'empty_conversations',
          message: 'Empty conversations were skipped. Exports keep an empty shell for conversations that were deleted.',
          count: tally.emptyConversations,
        });
      }
      if (tally.unrecognised > 0) {
        warnings.push({
          code: 'unrecognised_records',
          message: 'Some records in the file are not conversations (no "chat_messages" list) and were skipped.',
          count: tally.unrecognised,
        });
      }
      if (tally.unknownBlocks.size > 0) {
        warnings.push({
          code: 'unknown_content_blocks',
          message: 'Some content blocks have a type this version does not know and were not counted.',
          count: [...tally.unknownBlocks.values()].reduce((a, b) => a + b, 0),
          sample: [...tally.unknownBlocks.keys()].slice(0, 5).join(', '),
        });
      }
      if (tally.binaryFiles > 0) {
        warnings.push({
          code: 'binary_files_not_counted',
          message: 'Images, PDFs and other uploaded files cost tokens, but the export only lists their names. Their tokens are unavailable.',
          count: tally.binaryFiles,
        });
      }
      if (tally.conversationsWithoutPointers > 0) {
        warnings.push({
          code: 'no_branch_information',
          message:
            'This export has no parent pointers between messages (exports made before mid-2026 do not). Edited or regenerated messages cannot be told apart, so each conversation is treated as one thread in the order of its timestamps.',
          count: tally.conversationsWithoutPointers,
        });
      }
      if (tally.cappedMessages > 0) {
        warnings.push({
          code: 'context_capped',
          message: 'In very long conversations the re-read context was capped at the assumed context window.',
          count: tally.cappedMessages,
        });
      }

      const missingFields = ['model', 'token counts'];
      if (tally.conversationsWithoutPointers > 0) missingFields.push('parent_message_uuid');

      // The account most conversations belong to names the source; among equals the same one every time,
      // whatever order the file lists them in, so the next export of the same people adds to the same source.
      const account = [...tally.accounts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0]?.[0] ?? '';
      return {
        format: 'claude-export/conversations',
        formatLabel: 'claude.ai data export',
        parserVersion: CLAUDE_EXPORT_PARSER_VERSION,
        source: { kind: 'claude_export', label: 'claude.ai export', externalRef: account },
        fileName: importFileName(files, sameArchive(files)),
        fileSize: files.reduce((s, f) => s + f.size, 0),
        contentHash: hash.hex(),
        recordsSeen: records,
        recordsSkipped: tally.emptyConversations + tally.conversationsWithoutTime + tally.unrecognised,
        missingFields,
        warnings,
        stats: {
          conversations: tally.conversations,
          messages: tally.messages,
          userMessages: tally.userMessages,
          assistantMessages: tally.assistantMessages,
          thinkingBlocks: tally.thinkingBlocks,
          toolCalls: tally.toolCalls,
          attachments: tally.attachments,
          binaryFiles: tally.binaryFiles,
          branchedConversations: tally.branchedConversations,
          hasBranchInformation: tally.hasParentPointers,
          accounts: tally.accounts.size,
          bytesRead,
        },
      };
    },
  };
}
