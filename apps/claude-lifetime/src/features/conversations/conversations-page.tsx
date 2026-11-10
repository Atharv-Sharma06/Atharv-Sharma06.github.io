'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { Skeleton } from '@/components/ui/feedback';
import { ConversationDetailView } from './detail';
import { Explorer } from './explorer';
import { parseExplorerState, parseTarget } from './url-state';

/**
 * One route, two views. A static export cannot have a page per conversation, so the
 * conversation to show is named in the query string (`?id=`), next to the list state
 * it was opened from.
 */
function ConversationsRoute() {
  const params = useSearchParams();
  const target = parseTarget(params);
  const state = parseExplorerState(params);
  return target.view === 'detail' ? <ConversationDetailView id={target.id} listState={state} /> : <Explorer urlState={state} />;
}

export function ConversationsPage() {
  return (
    <Suspense
      fallback={
        <div aria-busy="true">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="mt-6 h-96 w-full" />
        </div>
      }
    >
      <ConversationsRoute />
    </Suspense>
  );
}
