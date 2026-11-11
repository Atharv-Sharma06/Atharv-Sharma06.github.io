'use client';

import { Download } from 'lucide-react';
import { Button, buttonClass } from '@/components/ui/button';
import { conversationParts, type ExportManifest } from '@/import/claude-export/manifest';
import { formatInstant } from '@/lib/format';
import { Notice } from './preview';

/** What the other categories of an export hold, as far as their names say, for the sentence about them. */
const CATEGORY: Record<string, string> = {
  light_metadata: 'account details',
  projects: 'projects',
  memories: 'memories',
  feedback: 'feedback',
  design_chats: 'design chats',
  frames: 'frames',
  artifact_data: 'artifact data',
  claude_code_cloud: 'Claude Code on the web',
};

/**
 * The step after a claude.ai export manifest was chosen: it holds no conversations, only the links to
 * the export's parts. The links work in a browser signed in to claude.ai, so the person downloads the
 * conversations parts and chooses them; the app itself fetches nothing.
 */
export function ExportManifestStep({
  manifest,
  problem,
  timezone,
  onChoose,
  onCancel,
}: {
  manifest: ExportManifest;
  /** What is wrong with another file that was chosen with the manifest. */
  problem?: string;
  timezone: string;
  onChoose: () => void;
  onCancel: () => void;
}) {
  const conversations = conversationParts(manifest);
  const one = conversations.length === 1;
  const others = [...new Set(manifest.parts.filter((p) => p.category !== 'conversations').map((p) => CATEGORY[p.category] ?? p.category.replace(/_/g, ' ')))];
  const cloud = manifest.parts.some((p) => p.category === 'claude_code_cloud');
  const made = manifest.createdAt && !Number.isNaN(Date.parse(manifest.createdAt)) ? formatInstant(manifest.createdAt, timezone, 'datetime') : null;

  return (
    <div className="space-y-4 text-ink-2">
      <p className="[overflow-wrap:anywhere]">
        <span className="text-ink">“{manifest.fileName}”</span> is the manifest of your claude.ai data export{made ? ` from ${made}` : ''}. It lists the parts of
        the export and where to download them, but holds none of your conversations itself.
      </p>

      {problem ? (
        <Notice tone="warning">
          <span className="[overflow-wrap:anywhere]">A file chosen with it could not be used: {problem}</span>
        </Notice>
      ) : null}

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
                  <li key={`${part.filename}-${i}`} className="min-w-0 max-w-full">
                    {part.url ? (
                      <a
                        href={part.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={buttonClass('secondary', 'md', 'h-auto min-h-9 max-w-full whitespace-normal py-1.5 text-left')}
                      >
                        <Download className="size-4 shrink-0" aria-hidden="true" />
                        <span className="min-w-0 [overflow-wrap:anywhere]">Download {part.filename}</span>
                      </a>
                    ) : (
                      // No link to show. A link that leads elsewhere than claude.ai is not one to follow, so the manifest is not pointed to.
                      <span className="text-[13px] [overflow-wrap:anywhere]">
                        <span className="text-ink">{part.filename}</span>:{' '}
                        {part.linkRejected
                          ? 'its link in the manifest does not lead to claude.ai, so it is not shown. Do not open it; request a new export on claude.ai instead.'
                          : 'the manifest gives no download link for it. Request a new export on claude.ai.'}
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
            <p className="text-[13px] [overflow-wrap:anywhere]">
              The app reads the conversations. The other parts ({new Intl.ListFormat('en', { type: 'conjunction' }).format(others)}) are not needed
              for them; when they are chosen as well, they are passed over.
              {cloud ? ' The Claude Code on the web part may hold your Claude Code sessions from the web: choose it on its own afterwards to see whether the app can read them.' : ''}
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
