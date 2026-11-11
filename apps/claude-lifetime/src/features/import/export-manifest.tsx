'use client';

import { Download } from 'lucide-react';
import { Button, buttonClass } from '@/components/ui/button';
import { conversationParts, type ExportManifest } from '@/import/claude-export/manifest';
import { formatInstant } from '@/lib/format';
import { Notice } from './preview';

/** What the other categories of an export hold, for the sentence that says they are not needed. */
const CATEGORY: Record<string, string> = {
  light_metadata: 'account details',
  projects: 'projects',
  memories: 'memories',
  feedback: 'feedback',
};

/**
 * The step after a claude.ai export manifest was chosen: it holds no conversations, only the links to
 * the export's parts. The links work in a browser signed in to claude.ai, so the person downloads the
 * conversations parts and chooses them; the app itself fetches nothing.
 */
export function ExportManifestStep({
  manifest,
  timezone,
  onChoose,
  onCancel,
}: {
  manifest: ExportManifest;
  timezone: string;
  onChoose: () => void;
  onCancel: () => void;
}) {
  const conversations = conversationParts(manifest);
  const one = conversations.length === 1;
  const others = [...new Set(manifest.parts.filter((p) => p.category !== 'conversations').map((p) => CATEGORY[p.category] ?? p.category.replace(/_/g, ' ')))];
  const made = manifest.createdAt && !Number.isNaN(Date.parse(manifest.createdAt)) ? formatInstant(manifest.createdAt, timezone, 'datetime') : null;

  return (
    <div className="space-y-4 text-ink-2">
      <p className="[overflow-wrap:anywhere]">
        <span className="text-ink">“{manifest.fileName}”</span> is the manifest of your claude.ai data export{made ? ` from ${made}` : ''}. It lists the parts of
        the export and where to download them, but holds none of your conversations itself.
      </p>

      {conversations.length === 0 ? (
        <Notice tone="warning">This export lists no conversations part, so there is nothing in it for the app to read. Request a new export on claude.ai.</Notice>
      ) : (
        <>
          <ol className="list-decimal space-y-3 pl-5">
            <li>
              <p>
                Download the conversations {one ? 'part' : `parts (all ${conversations.length} of them)`}. Each link opens claude.ai in a new tab, which
                downloads the file; this browser has to be signed in to claude.ai. A link may work only once, and the links expire about a day after the
                export was made.
              </p>
              <ul className="mt-2 flex flex-wrap gap-2">
                {conversations.map((part, i) => (
                  <li key={`${part.filename}-${i}`}>
                    {part.url ? (
                      <a href={part.url} target="_blank" rel="noopener noreferrer" className={buttonClass('secondary')}>
                        <Download className="size-4" aria-hidden="true" />
                        Download {part.filename}
                      </a>
                    ) : (
                      <span className="text-[13px]">
                        {part.filename} <span className="text-ink-3">(its link is in the manifest file)</span>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </li>
            <li>
              <p>Choose the downloaded {one ? 'file' : 'files'} here{one ? '' : ', all together'}.</p>
              <Button variant="primary" className="mt-2" onClick={onChoose}>
                Choose the downloaded {one ? 'ZIP' : 'ZIPs'}
              </Button>
            </li>
          </ol>
          {others.length > 0 ? (
            <p className="text-[13px]">
              The other parts ({new Intl.ListFormat('en', { type: 'conjunction' }).format(others)}) hold no usage and are not needed. Choosing them
              together with the conversations does no harm.
            </p>
          ) : null}
        </>
      )}

      <div className="flex justify-end">
        <Button onClick={onCancel}>Choose another file</Button>
      </div>
    </div>
  );
}
