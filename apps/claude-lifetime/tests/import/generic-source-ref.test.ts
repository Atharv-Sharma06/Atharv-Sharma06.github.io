import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sourceRefFromName } from '@/import/generic/source-ref';

/**
 * The reference a CSV table gets from the name the person types for its source. The
 * reference decides which rows count as already stored, and a table filed under the
 * reference of another takes over its name, so different names need different
 * references in every script.
 */
const hashOf = (text: string) => `~${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;

describe('sourceRefFromName', () => {
  it('gives plain ASCII names the reference they always had', () => {
    // The expression the mapping step used before. Tables stored under these references must still be found.
    const before = (text: string) =>
      text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
    const names = ['Proxy EU', 'proxy-eu', '  Gateway logs  ', 'My_Table (v2)!', 'A', '2026', 'log.2026-03.csv', '-- x --', 'x'.repeat(80), 'ab '.repeat(30), `${'a'.repeat(47)} b`];
    for (const name of names) expect(sourceRefFromName(name), name).toBe(before(name));
    expect(sourceRefFromName('Proxy EU')).toBe('proxy-eu');
    expect(sourceRefFromName('My_Table (v2)!')).toBe('my-table-v2');
  });

  it('gives names in other scripts a reference of their own', () => {
    expect(sourceRefFromName('プロキシ東京')).toBe('プロキシ東京');
    expect(sourceRefFromName('プロキシ大阪')).toBe('プロキシ大阪');
    expect(sourceRefFromName('Журнал прокси')).toBe('журнал-прокси');
    expect(sourceRefFromName('日志')).toBe('日志');
    expect(sourceRefFromName('Αρχείο 2026')).toBe('αρχείο-2026');
    expect(sourceRefFromName('سجل الوكيل')).toBe('سجل-الوكيل');
    expect(sourceRefFromName('Büro')).toBe('büro');
    // Vowel signs are marks, not letters, and two names can differ in nothing else.
    expect(sourceRefFromName('दिन')).not.toBe(sourceRefFromName('दीन'));
    expect(sourceRefFromName('ปี')).not.toBe(sourceRefFromName('ปู'));

    const names = ['Proxy EU', 'プロキシ東京', 'プロキシ大阪', 'Журнал прокси', '日志', 'Αρχείο 2026', 'سجل الوكيل', 'Büro', 'Buro', 'दिन', 'दीन', 'ปี', 'ปู', '***', '🙂'];
    const references = names.map(sourceRefFromName);
    expect(new Set(references).size).toBe(names.length);
    // None of them is the reference of the unnamed source.
    expect(references).not.toContain('');
    // A reference is part of every row key, where a colon separates it from the row's id.
    for (const reference of references) expect(reference).not.toContain(':');
  });

  it('treats different spellings of one name as the same source', () => {
    // full-width letters and an ideographic space, as an input method writes them
    expect(sourceRefFromName('Ｐｒｏｘｙ　ＥＵ')).toBe('proxy-eu');
    // an accent typed as a character of its own
    expect(sourceRefFromName('Café')).toBe(sourceRefFromName('Café'));
    expect(sourceRefFromName('Café')).toBe('café');
    // case, spacing and punctuation do not make another source, as before
    expect(sourceRefFromName('ЖУРНАЛ  прокси!')).toBe('журнал-прокси');
    expect(sourceRefFromName(' プロキシ東京 ')).toBe('プロキシ東京');
  });

  it('gives a name without letters or digits a short hash, never the unnamed source', () => {
    expect(sourceRefFromName('***')).toBe(hashOf('***'));
    expect(sourceRefFromName('🙂')).toBe(hashOf('🙂'));
    expect(sourceRefFromName('—')).toBe(hashOf('—'));
    expect(sourceRefFromName('***')).toMatch(/^~[0-9a-f]{12}$/);
    expect(sourceRefFromName('***')).not.toBe(sourceRefFromName('---'));
    // spacing inside such a name makes no difference either
    expect(sourceRefFromName('★   ★')).toBe(sourceRefFromName(' ★ ★ '));
    // A name made of letters can never produce a reference that starts with the tilde.
    expect(sourceRefFromName(`~${hashOf('***').slice(1)}`)).toBe(hashOf('***').slice(1));
    // An accent on its own is no letter.
    expect(sourceRefFromName('¨')).toMatch(/^~[0-9a-f]{12}$/);
  });

  it('gives only an empty name the empty reference', () => {
    for (const name of ['', ' ', '   ', '\t\n', '　', ' ']) expect(sourceRefFromName(name), JSON.stringify(name)).toBe('');
  });

  it('limits the length without cutting a character in half', () => {
    expect(sourceRefFromName('ж'.repeat(80))).toBe('ж'.repeat(48));
    // Characters outside the basic plane take two code units each.
    const long = sourceRefFromName('𠮷'.repeat(60));
    expect(Array.from(long)).toHaveLength(48);
    expect(long).toBe('𠮷'.repeat(48));
  });
});
