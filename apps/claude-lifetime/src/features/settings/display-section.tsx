'use client';

import { CircleDashed } from 'lucide-react';
import { useCallback, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { TokenBasis } from '@/analytics/base';
import type { AppSettings } from '@/analytics/settings';
import { getOverview } from '@/analytics/overview';
import { getApiValue } from '@/analytics/value';
import { ConfidenceBadge, confidenceOf, type ConfidenceLevel } from '@/components/data/confidence';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/controls';
import { Skeleton } from '@/components/ui/feedback';
import { InfoTip } from '@/components/ui/overlay';
import { Decimal } from '@/core/decimal';
import { cn } from '@/lib/cn';
import { formatInt, formatMonth, formatTokens, formatUsd } from '@/lib/format';
import { useApp, useData } from '@/state/app';
import { useCatalogModels, useCoverage } from '@/state/queries';
import { checkTimezone, deviceTimezone, isWholeValueInput, listTimezones, utcOffsetLabel } from './logic';
import { ChoiceCards, SaveError, SaveNote, SettingRow, SettingsSection, useSaveState } from './parts';

type CostScenario = AppSettings['costScenario'];

/**
 * A preference that saves the moment it changes. The control shows the new choice at
 * once and falls back to the stored one if saving fails.
 */
function useSetting<T>(saved: T, persist: (value: T) => Promise<unknown>) {
  const save = useSaveState();
  const { run } = save;
  const [pending, setPending] = useState<{ value: T } | null>(null);
  const latest = useRef(0);
  const change = useCallback(
    async (value: T) => {
      const ticket = ++latest.current;
      setPending({ value });
      await run(() => persist(value));
      if (latest.current === ticket) setPending(null);
    },
    [persist, run],
  );
  return { value: pending ? pending.value : saved, change, state: save.state };
}

/** Lifetime equivalent API value under the current settings: shows what the two pricing preferences below change. */
function useLifetimeValue(assumedModelKey: string | null) {
  return useData(['settings', 'lifetime-value', assumedModelKey], (a) => getApiValue(a.db, a.lifetime, { assumedModelKey }));
}

/** Lifetime totals under one token basis, whichever basis is selected. */
function useLifetimeTokens(basis: TokenBasis) {
  return useData(['settings', 'lifetime-tokens', basis], (a) => getOverview(a.db, { ...a.lifetime, basis }));
}

/** What a preference does to the user's own figures, said in one line under the control. */
function Effect({ children, level, stale }: { children: ReactNode; level?: ConfidenceLevel; stale?: boolean }) {
  return (
    <div className={cn('mt-3 flex items-start gap-2.5 text-[13px] text-ink-2 transition-opacity', stale && 'opacity-70')}>
      {level ? <ConfidenceBadge level={level} className="mt-px" /> : null}
      <p className="min-w-0 max-w-[68ch]">{children}</p>
    </div>
  );
}

function Figure({ children }: { children: ReactNode }) {
  return <span className="tabular text-ink">{children}</span>;
}

// ── Timezone ────────────────────────────────────────────────────────────────────

function TimezoneSetting() {
  const { settings, saveSettings } = useApp();
  const saved = settings.timezone;
  const zones = useMemo(() => listTimezones(), []);
  const device = useMemo(() => deviceTimezone(), []);
  const [draft, setDraft] = useState(saved);
  const [shownFor, setShownFor] = useState(saved);
  const [problem, setProblem] = useState<string | null>(null);
  const save = useSaveState();
  const listId = useId();
  const hintId = useId();

  // The stored zone changed (saved here, in another tab, or by a restore): the field follows it.
  if (shownFor !== saved) {
    setShownFor(saved);
    setDraft(saved);
    setProblem(null);
  }

  const commit = async (raw: string) => {
    const check = checkTimezone(raw, zones);
    if (!check.ok) {
      save.reset();
      setProblem(check.message);
      return;
    }
    setProblem(null);
    if (check.timezone === saved) {
      save.reset();
      setDraft(saved);
      return;
    }
    await save.run(() => saveSettings({ timezone: check.timezone }));
  };

  const error = problem ?? (save.state.status === 'error' ? save.state.message : null);
  const offset = utcOffsetLabel(saved);

  return (
    <SettingRow
      id="timezone"
      title="Timezone"
      description={
        <p>
          Decides which calendar day a message belongs to. Every chart, daily total and date range uses these day boundaries.{' '}
          <span className="inline-flex translate-y-1">
            <InfoTip label="About usage reported per day">
              <p>
                Usage reports that arrive as whole days (daily API reports) are already cut at midnight UTC. They keep those dates, because a daily
                total cannot be split again along another timezone.
              </p>
            </InfoTip>
          </span>
        </p>
      }
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
        <Input
          className="sm:max-w-[19rem]"
          list={listId}
          value={draft}
          aria-labelledby="timezone-label"
          aria-describedby={hintId}
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="For example Europe/Berlin"
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            const next = e.target.value;
            setDraft(next);
            setProblem(null);
            if (zones.includes(next) && isWholeValueInput((e.nativeEvent as InputEvent).inputType)) void commit(next);
          }}
          onBlur={() => {
            if (draft.trim() === '') {
              setDraft(saved);
              setProblem(null);
            } else if (draft !== saved) {
              void commit(draft);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void commit(draft);
            } else if (e.key === 'Escape' && draft !== saved) {
              e.preventDefault();
              save.reset();
              setDraft(saved);
              setProblem(null);
            }
          }}
        />
        <datalist id={listId}>
          {zones.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
        <Button onClick={() => device && void commit(device)} disabled={!device || device === saved}>
          Use this device’s timezone
        </Button>
        <SaveNote state={save.state} />
      </div>
      {error ? (
        <p role="alert" className="mt-2 max-w-[68ch] text-[13px] text-critical">
          {error} Nothing was changed: the app still uses {saved}.
        </p>
      ) : null}
      <p id={hintId} className="mt-2 text-[13px] text-ink-2">
        In use: <span className="text-ink">{saved}</span>
        {offset ? <>, currently {offset}</> : null}.{' '}
        {device === null ? null : device === saved ? 'This is also the timezone of this device.' : `This device is set to ${device}.`}
      </p>
    </SettingRow>
  );
}

// ── Token basis ─────────────────────────────────────────────────────────────────

function BasisSetting() {
  const { settings, saveSettings } = useApp();
  const persist = useCallback((basis: TokenBasis) => saveSettings({ basis }), [saveSettings]);
  const basis = useSetting(settings.basis, persist);
  const processed = useLifetimeTokens('processed');
  const fresh = useLifetimeTokens('new');

  let effect: ReactNode = <Skeleton className="mt-3 h-5 w-80 max-w-full" />;
  const failure = processed.error ?? fresh.error;
  if (failure) {
    effect = <Effect>Your totals could not be read: {failure.message}</Effect>;
  } else if (processed.data && fresh.data) {
    const p = processed.data.tokens;
    const n = fresh.data.tokens;
    effect =
      p.total === 0 ? null : (
        <Effect level={confidenceOf(p.exact, p.estimated)} stale={processed.isPlaceholderData || fresh.isPlaceholderData}>
          Over your whole history that is{' '}
          <span className="tabular text-ink" title={`${formatInt(p.total)} tokens`}>
            {formatTokens(p.total)}
          </span>{' '}
          processed tokens, or{' '}
          <span className="tabular text-ink" title={`${formatInt(n.total)} tokens`}>
            {formatTokens(n.total)}
          </span>{' '}
          new tokens.
        </Effect>
      );
  }

  return (
    <SettingRow
      id="token-basis"
      title="Token basis"
      description={
        <p>
          Which tokens every total, chart and table counts. This is the same switch as the one in the top bar; changing either changes both.
        </p>
      }
    >
      <ChoiceCards<TokenBasis>
        labelledBy="token-basis-label"
        value={basis.value}
        onChange={(next) => void basis.change(next)}
        state={basis.state}
        options={[
          {
            value: 'processed',
            title: 'Processed',
            description:
              'Everything the model read and wrote, including cache reads and the earlier context it re-reads on every turn. This is what the API meters.',
          },
          {
            value: 'new',
            title: 'New',
            description: 'Each piece of content counted once: input, output and cache writes. Re-read context and cache reads are left out.',
          },
        ]}
      />
      <div aria-busy={!failure && !(processed.data && fresh.data) ? true : undefined}>{effect}</div>
      <SaveError state={basis.state} className="mt-2" />
    </SettingRow>
  );
}

// ── Cost scenario ───────────────────────────────────────────────────────────────

function CostScenarioSetting() {
  const { settings, saveSettings } = useApp();
  const persist = useCallback((costScenario: CostScenario) => saveSettings({ costScenario }), [saveSettings]);
  const scenario = useSetting(settings.costScenario, persist);
  const coverage = useCoverage();
  const value = useLifetimeValue(settings.assumedModelKey);

  let effect: ReactNode = <Skeleton className="mt-3 h-5 w-80 max-w-full" />;
  const failure = value.error ?? coverage.error;
  if (failure) {
    effect = <Effect>The effect on your figures could not be read: {failure.message}</Effect>;
  } else if (value.data && coverage.data) {
    const standard = Decimal.from(value.data.estimatedStandardUsd);
    const cached = Decimal.from(value.data.estimatedCachedUsd);
    if (!coverage.data.hasData) {
      effect = null;
    } else if (coverage.data.estimatedTokens === 0) {
      effect = <Effect>None of your imported usage is estimated, so this choice changes no figure at the moment.</Effect>;
    } else if (standard.isZero() && cached.isZero()) {
      effect = (
        <Effect>
          Your estimated usage has no recorded model, so it is not priced and both scenarios show the same figures. It only gets a price once you
          choose an assumed model below.
        </Effect>
      );
    } else {
      effect = (
        <Effect level="estimated" stale={value.isPlaceholderData}>
          At list prices, your estimated usage comes to <Figure>{formatUsd(value.data.estimatedStandardUsd)}</Figure> without prompt caching and{' '}
          <Figure>{formatUsd(value.data.estimatedCachedUsd)}</Figure> with a 5-minute cache, over your whole history.
        </Effect>
      );
    }
  }

  return (
    <SettingRow
      id="cost-scenario"
      title="Cost scenario for estimated chat usage"
      description={
        <>
          <p>
            A claude.ai export contains no token counts, so chat usage is estimated. What it would have cost through the API depends on whether
            prompt caching is assumed. Choose which figure the app leads with.
          </p>
          <p>Exact usage is not affected: its cache reads and writes are recorded, so each is priced at its own rate.</p>
        </>
      }
    >
      <ChoiceCards<CostScenario>
        labelledBy="cost-scenario-label"
        value={scenario.value}
        onChange={(next) => void scenario.change(next)}
        state={scenario.state}
        options={[
          {
            value: 'standard',
            title: 'Without prompt caching',
            description: 'Context that is sent again on every turn is priced as regular input, at the full input price.',
          },
          {
            value: 'cached',
            title: 'With a 5-minute prompt cache',
            description:
              'Context a cache could have served is priced as cache reads. Everything else sent to the model is priced as 5-minute cache writes.',
          },
        ]}
      />
      <div aria-busy={!failure && !(value.data && coverage.data) ? true : undefined}>{effect}</div>
      <SaveError state={scenario.state} className="mt-2" />
    </SettingRow>
  );
}

// ── Assumed model ───────────────────────────────────────────────────────────────

const NO_MODEL = 'none';

function AssumedModelSetting() {
  const { settings, saveSettings } = useApp();
  const persist = useCallback((key: string) => saveSettings({ assumedModelKey: key === NO_MODEL ? null : key }), [saveSettings]);
  const choice = useSetting(settings.assumedModelKey ?? NO_MODEL, persist);
  const models = useCatalogModels();
  const coverage = useCoverage();
  const value = useLifetimeValue(settings.assumedModelKey);
  // The same history priced with nothing assumed: the difference is what the assumption adds.
  const baseline = useLifetimeValue(null);

  const priced = (models.data ?? []).filter((m) => m.hasStandardPrice);
  const stored = settings.assumedModelKey;
  const storedModel = stored === null ? null : ((models.data ?? []).find((m) => m.modelKey === stored) ?? null);
  // A stored choice can lose its price (a price the user entered was deleted) or leave the catalog with the import that named it.
  const orphaned = stored !== null && models.data !== undefined && !priced.some((m) => m.modelKey === stored);
  const options = [
    { value: NO_MODEL, label: 'None: leave it unpriced' },
    ...(orphaned ? [{ value: stored, label: storedModel?.displayName ?? stored, hint: 'no standard price' }] : []),
    ...priced.map((m) => ({ value: m.modelKey, label: m.displayName, hint: m.releasedOn ? `released ${formatMonth(m.releasedOn)}` : undefined })),
  ];
  const assumedName = storedModel?.displayName ?? stored ?? '';
  const withoutModel = coverage.data?.tokensWithoutModel ?? null;

  let added: string | null = null;
  if (value.data && baseline.data && stored !== null) {
    const pick = (v: { totalStandardUsd: string; totalCachedUsd: string }) => (settings.costScenario === 'cached' ? v.totalCachedUsd : v.totalStandardUsd);
    added = Decimal.from(pick(value.data)).sub(pick(baseline.data)).toString(6);
  }

  return (
    <SettingRow
      id="assumed-model"
      title="Assumed model for usage with no recorded model"
      description={
        <>
          <p>
            Some sources do not say which model answered, and a claude.ai export never does. That usage appears as Unknown model and has no
            equivalent API value, because a price belongs to a model and none is guessed.
          </p>
          <p>If you know what you were using, you can name the model whose prices should stand in.</p>
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {models.data ? (
          <Select
            label="Assumed model for usage with no recorded model"
            className="w-full sm:w-[19rem]"
            value={choice.value}
            onChange={(next) => void choice.change(next)}
            options={options}
          />
        ) : (
          <Skeleton className="h-9 w-full sm:w-[19rem]" />
        )}
        <SaveNote state={choice.state} />
      </div>
      <SaveError state={choice.state} className="mt-2" />
      {models.error ? (
        <p role="alert" className="mt-2 text-[13px] text-critical">
          The model catalog could not be read: {models.error.message}
        </p>
      ) : null}

      {stored === null ? (
        <Effect>
          Nothing is guessed.{' '}
          {withoutModel === null || !coverage.data?.hasData ? null : withoutModel > 0 ? (
            <>
              <Figure>{formatTokens(withoutModel)}</Figure> processed tokens in your history have no recorded model and stay unpriced.
            </>
          ) : (
            'All of your imported usage names its model, so there is nothing to assume.'
          )}
        </Effect>
      ) : (
        <div className="mt-3 max-w-[68ch] rounded-[var(--radius-control)] border border-line bg-raised px-3.5 py-3 text-[13px] text-ink-2">
          <p className="flex items-center gap-1.5 font-medium text-ink">
            <CircleDashed className="size-4 text-warning" strokeWidth={2.25} aria-hidden="true" />
            This is your assumption, not something your files record
          </p>
          <p className="mt-1.5">
            Usage with no recorded model is priced as if {assumedName} had answered. It only changes the equivalent API value. Token counts and the
            model breakdown stay exactly as imported, where this usage remains Unknown model, and every figure that includes it is labelled as
            estimated.
          </p>
          {orphaned ? (
            <p className="mt-1.5">
              {assumedName} has no standard price on file at the moment, so this usage is still unpriced. Choose another model, or add a price for
              it under Prices.
            </p>
          ) : value.data ? (
            <p className={value.isPlaceholderData ? 'mt-1.5 opacity-70 transition-opacity' : 'mt-1.5 transition-opacity'}>
              {value.data.assumedTokens > 0 ? (
                <>
                  Right now it prices <Figure>{formatTokens(value.data.assumedTokens)}</Figure> processed tokens
                  {added !== null ? (
                    <>
                      {' '}
                      and adds <Figure>{formatUsd(added)}</Figure> to your lifetime equivalent API value
                    </>
                  ) : null}
                  .
                </>
              ) : (
                'Right now none of your usage lacks a model, so it changes no figure.'
              )}
            </p>
          ) : null}
        </div>
      )}
    </SettingRow>
  );
}

export function DisplaySection() {
  return (
    <SettingsSection
      id="display"
      title="Display and accounting"
      description="How days are drawn, which tokens are counted and how usage is valued. A change applies to every page straight away."
    >
      <Card className="divide-y divide-line">
        <TimezoneSetting />
        <BasisSetting />
        <CostScenarioSetting />
        <AssumedModelSetting />
      </Card>
    </SettingsSection>
  );
}
