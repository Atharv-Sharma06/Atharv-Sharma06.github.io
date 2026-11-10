import { sha256Hex } from '@/core/sha256';

/**
 * The reference of a source that the person named in the import UI.
 *
 * The reference, not the name, keeps sources apart: rows count as already stored
 * only within one reference, and a table filed under the reference of another takes
 * over its name. Two names a person would call different must therefore never end in
 * the same reference, whatever script they are written in.
 *
 * This module has no parser code, so the import page can use it without loading one.
 */

/** Longest reference made from a name, in characters. */
const MAX_REFERENCE_LENGTH = 48;

/**
 * What separates the words of a name: every run of characters that are neither
 * letters nor digits. Combining marks stay with their letters, because in Thai,
 * Hindi or Arabic the vowel signs are marks and two names can differ in nothing else.
 */
const SEPARATORS = /[^\p{L}\p{M}\p{N}]+/gu;

export function sourceRefFromName(name: string): string {
  // NFKC makes the ways of typing one text equal: full-width and half-width letters,
  // an accent typed as its own character. Case and spacing never made another source.
  const text = name.normalize('NFKC').toLowerCase().trim();
  // Only a name that was not given stands for the unnamed source.
  if (text === '') return '';

  // Cut by characters, not by UTF-16 units, so that no character is left as half a pair.
  const words = Array.from(text.replace(SEPARATORS, '-').replace(/^-+|-+$/g, '')).slice(0, MAX_REFERENCE_LENGTH).join('');
  if (/[\p{L}\p{N}]/u.test(words)) return words;

  // A name of symbols only ("***", an emoji) has no letters to build a reference from.
  // It still is a name: a short hash keeps it apart from other such names and from the
  // unnamed source. The tilde cannot come out of the lines above, so no name made of
  // letters shares a reference with it.
  return `~${sha256Hex(text.replace(/\s+/g, ' ')).slice(0, 12)}`;
}
