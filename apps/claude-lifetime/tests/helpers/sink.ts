import type { ImportFile, ImportProgress, ImportSink, StagedConversation, StagedCost, StagedMessage, StagedModel, StagedUsage } from '@/core/types';

/** An ImportSink that keeps everything in memory, for parser tests. */
export function collectingSink() {
  const out = {
    conversations: [] as StagedConversation[],
    messages: [] as StagedMessage[],
    usage: [] as StagedUsage[],
    costs: [] as StagedCost[],
    models: [] as StagedModel[],
    progress: [] as ImportProgress[],
  };
  const sink: ImportSink = {
    conversation: (c) => void out.conversations.push(c),
    message: (m) => void out.messages.push(m),
    usage: (u) => void out.usage.push(u),
    cost: (c) => void out.costs.push(c),
    model: (m) => void out.models.push(m),
    progress: (p) => void out.progress.push(p),
  };
  return { out, sink };
}

export function fileOf(name: string, content: string | Uint8Array, extra: Partial<ImportFile> = {}): ImportFile {
  const blob = new Blob([content as unknown as BlobPart]);
  return { name, size: blob.size, blob, ...extra };
}
