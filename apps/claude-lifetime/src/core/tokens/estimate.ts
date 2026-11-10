/**
 * Fast estimate of how many tokens a text is for the legacy Claude tokenizer.
 *
 * One "base unit" is one token as counted by `countTokens` from `@anthropic-ai/tokenizer` (the legacy
 * tokenizer Anthropic published; BPE over UTF-8 bytes after NFKC, GPT-2 style pre-tokenisation). Callers scale
 * base units by a per-model-generation factor; this module only approximates the legacy count, in one pass
 * over the UTF-16 code units, without dependencies, so it also runs in a browser or a Web Worker.
 *
 * THE MODEL ('heuristic-v1')
 *
 * The legacy tokenizer first cuts text into pieces and never merges across them: a run of letters, a run of
 * digits or a run of other non-space characters, each optionally preceded by ONE space; contractions
 * ('s 't 're 've 'm 'll 'd); and whitespace runs. The estimator reproduces that cut exactly for ASCII and
 * prices every piece with coefficients fitted against the real tokenizer:
 *
 *  - Whitespace: a single space before a piece is free. Any other whitespace run is 1 token (2 when longer
 *    than 64 characters), plus 1 when it ends in a newline or tab instead of a space.
 *  - Digits: by run length (1-3 digits about 1 token, then about 0.4 per digit).
 *  - ASCII punctuation: 1 token per run plus, for every adjacent pair, the measured probability that the
 *    tokenizer splits between those two characters (33 x 33 table; `://`, `":"` or `-----` are cheap).
 *  - Latin words: split at camelCase humps into segments; each segment costs A[shape][length] + z * B[shape][length].
 *    A is the curve of plain English and code (about 1 token up to 8 letters). z says how un-English the
 *    spelling of the current LINE is: the mean of a 28 x 28 letter-pair weight table over the line's letters
 *    (about -0.1 for English prose, 0.5-0.6 for Spanish/French/Portuguese, 0.75-0.9 for German/Italian,
 *    1.5-1.7 for Polish/Czech/Turkish), and B is what a non-English word of that length costs extra.
 *    Letters with diacritics add a fixed cost.
 *  - Every other character has a class: script (Greek, Cyrillic, Hebrew, Arabic, Devanagari, other Indic, Thai,
 *    Han, kana, Hangul, symbols, marks, other, emoji) x the number of tokens the character needs on its own
 *    (1, 2 or 3; taken from the vocabulary, see ONE_TOKEN_CHARS / TWO_TOKEN_BLOCKS). Each class has one fitted
 *    cost per character (the common Cyrillic letters have individual costs, which separates Russian from
 *    Ukrainian), plus a fitted constant at the start of each run.
 *
 * The estimate is the rounded sum. It is deterministic, and additive across line breaks: the only state that
 * spans pieces is the per-line profile z (and whether the previous piece ended in a space or a digit).
 *
 * CALIBRATION
 *
 * Fitted with `node scripts/calibrate-tokens.mjs --fit` on: source code, Markdown, JSON, CSV, logs and licence
 * texts found on the build machine, the localisation files shipped in node_modules (typescript, axe-core, zod)
 * and the even-numbered six-line blocks of tests/fixtures/tokens/*.txt. `node scripts/calibrate-tokens.mjs`
 * prints the validation report (add `--all` for the machine corpora). The script also holds a slow reference
 * implementation of this model and checks that it returns exactly what this file returns.
 *
 * MEASURED ACCURACY (estimate / countTokens - 1, as printed by `node scripts/calibrate-tokens.mjs --all`)
 *
 *  - Held-out documents of the machine corpora (1,035 samples, 1.64 M tokens): +0.56% pooled. Per class:
 *    English prose +1.3%, Markdown +0.8%, source code +0.9%, minified code -1.3%, JSON -1.5%, CSV/tables -0.6%,
 *    logs +1.2%, URLs/paths/hex/base64 -2.2%, numbers -0.1%, Spanish +0.9%, French +2.1%, German -0.6%,
 *    Portuguese +2.7%, Italian -3.3%, Russian +6.4%, Greek +0.9%, Hebrew -0.3%, Japanese +0.9%, Korean +3.7%,
 *    Chinese +3.0% (the non-English text there is software localisation, i.e. technical prose).
 *  - tests/fixtures/tokens (42 hand-written files, 46,009 tokens): -0.13% pooled; every class within +-3.1%
 *    except Korean (-7.8%). On the half of each file that was not used for fitting: +0.02% pooled, every class
 *    within +-4.5% except Korean (-11.9%).
 *  - Of the 2,891 samples with at least 2,000 characters, 99.6% are within +-12% and 92.6% within +-6%.
 *
 * KNOWN WEAK SPOTS
 *
 *  - Korean: -6% to -12% on everyday prose and +4% on technical prose (one cost per syllable class cannot
 *    tell which syllable pairs the vocabulary merges). Chinese legal prose -10%, Russian technical prose +6%.
 *  - Latin-script languages that were not calibrated (Dutch, Indonesian: about -14%), Urdu (-8%), and
 *    decomposed (NFD) Vietnamese (+27%, combining marks are counted as extra letters).
 *  - Single documents that consist of unusual material: long base64 blobs (about -10%), hex test vectors,
 *    generated identifier tables (+-15% to +-28% in the worst cases seen).
 *
 * SPEED
 *
 * 50-120 million UTF-16 code units per second in Node 22 on the build machine (100-240 MB/s of UTF-16),
 * depending on the text and on how warm the JIT is; no allocation per call.
 */

export const ESTIMATE_MODEL_VERSION = 'heuristic-v1';

// ---------------------------------------------------------------------------------------------------------
// Character kinds
// ---------------------------------------------------------------------------------------------------------
const K_SP = 0; // space, and the Unicode spaces that NFKC turns into U+0020 (no-break space, U+3000, ...)
const K_NL = 1; // line feed
const K_WS = 2; // tab, CR, VT, FF, NEL, line/paragraph separator
const K_LO = 3; // a-z (and full-width variants)
const K_UP = 4; // A-Z
const K_DG = 5; // 0-9 (and full-width / superscript variants)
const K_PU = 6; // ASCII punctuation, symbols and control characters
const K_LX = 7; // Latin letter with a diacritic, or a combining diacritical mark
const K_HS = 8; // high surrogate
const K_LS = 9; // low surrogate
const K_X = 10; // any other character; AUX holds its cost class

// Script groups of the cost classes (class = 1 + group * 3 + tokensOnItsOwn - 1).
const N_GROUPS = 16;
const G_LATIN = 0;
const G_CYRILLIC = 2;
const G_HAN = 8;
const G_OTHER = 13;
const G_EMOJI = 14;
const G_ASTRAL = 15;
const N_GENERIC = N_GROUPS * 3;
const CYR_FIRST = 0x0430; // U+0430..U+045F get one class per letter
const CYR_COUNT = 48;
const N_CLASSES = 1 + N_GENERIC + CYR_COUNT;
const CLASS_LONE_SURROGATE = 1 + G_OTHER * 3 + 2;
const CLASS_HAN_3 = 1 + G_HAN * 3 + 2;
const CLASS_EMOJI_2 = 1 + G_EMOJI * 3 + 1;
const CLASS_EMOJI_3 = 1 + G_EMOJI * 3 + 2;
const CLASS_ASTRAL_3 = 1 + G_ASTRAL * 3 + 2;

/**
 * [first, last, group] triples for the Basic Multilingual Plane; later entries override earlier ones.
 * Groups: 0 latin, 1 greek, 2 cyrillic, 3 hebrew, 4 arabic, 5 devanagari, 6 other indic, 7 thai, 8 han, 9 kana,
 * 10 hangul, 11 symbol/punctuation, 12 mark/format, 13 other.
 */
const SCRIPT_RANGES: number[] = [
  0x0080, 0xffff, 13, 0x00a1, 0x00bf, 11, 0x00aa, 0x00aa, 0, 0x00b5, 0x00b5, 0, 0x00ba, 0x00ba, 0,
  0x00c0, 0x02af, 0, 0x00d7, 0x00d7, 11, 0x00f7, 0x00f7, 11, 0x02b0, 0x02ff, 11, 0x0300, 0x036f, 0,
  0x0370, 0x03ff, 1, 0x1f00, 0x1fff, 1, 0x0400, 0x052f, 2, 0x0590, 0x05ff, 3, 0xfb1d, 0xfb4f, 3,
  0x0600, 0x06ff, 4, 0x0750, 0x077f, 4, 0x08a0, 0x08ff, 4, 0xfb50, 0xfdff, 4, 0xfe70, 0xfefe, 4,
  0x0900, 0x097f, 5, 0x0980, 0x0dff, 6, 0x0e00, 0x0eff, 7, 0x1e00, 0x1eff, 0, 0x2c60, 0x2c7f, 0,
  0xa720, 0xa7ff, 0, 0xfb00, 0xfb06, 0, 0x2010, 0x2027, 11, 0x2030, 0x205e, 11, 0x2070, 0x20cf, 11,
  0x2100, 0x2bff, 11, 0x2e00, 0x2e7f, 11, 0x200b, 0x200f, 12, 0x202a, 0x202e, 12, 0x2060, 0x206f, 12,
  0x20d0, 0x20ff, 12, 0xfe00, 0xfe0f, 12, 0xfe20, 0xfe2f, 12, 0xfeff, 0xfeff, 12, 0x2e80, 0x2fdf, 8,
  0x3400, 0x4dbf, 8, 0x4e00, 0x9fff, 8, 0xf900, 0xfaff, 8, 0x3001, 0x303f, 11, 0x3200, 0x33ff, 11,
  0x4dc0, 0x4dff, 11, 0xfe10, 0xfe1f, 11, 0xfe30, 0xfe6f, 11, 0xff5f, 0xff65, 11, 0xffe0, 0xffee, 11,
  0x3040, 0x30ff, 9, 0x31f0, 0x31ff, 9, 0xff66, 0xff9f, 9, 0xac00, 0xd7a3, 10,
];

const SEG_LEN = 16; // segment lengths 1..16 are tabulated
const SEG_W = SEG_LEN + 1;
const SEG_FREE = 3;
const SEG_IN_CAP = 9;
const SEG_IN_UPPER = 10;
const DIGIT_LEN = 8;
const N_SYM = 28; // 26 letters, letter with diacritic, word boundary
const SYM_DIACRITIC = 26;
const SYM_BOUNDARY = 27;
const N_PUNCT = 33;

// <fitted-constants> generated by `node scripts/calibrate-tokens.mjs --fit`; do not edit by hand.
/** Letters in the per-line profile: z = sum(U[pair]) / (pairs + KAPPA), clamped to [Z_MIN, Z_MAX]. */
const KAPPA = 12;
const Z_MIN = -1;
const Z_MAX = 3;
/**
 * Latin word segments: tokens = A[shape][length] + z * B[shape][length]; index 0 is the slope per extra letter
 * beyond 16 letters. Shapes: lower_sp, lower, lower_dg, cap_sp, cap, cap_dg, upper_sp, upper, upper_dg, in_cap, in_upper
 * (_sp = after a space, _dg = directly after a digit, in_ = later camelCase hump of the same word).
 */
const SEG_A: number[][] = [
  [0.7, 0.982, 1, 0.997, 1.009, 1.035, 1.07, 1.116, 1.202, 1.232, 1.184, 1.412, 1.387, 1.442, 1.82, 2.52, 3.22], // lower_sp
  [0.172, 0.999, 0.928, 1.05, 1.019, 1.036, 1.08, 1.133, 1.154, 1.242, 1.373, 1.405, 1.679, 1.974, 1.889, 2.061, 2.233], // lower
  [0.128, 0.922, 1.06, 1.632, 2.124, 2.033, 3.061, 2.85, 1.546, 1.674, 1.803, 1.931, 2.059, 2.187, 2.315, 2.444, 2.572], // lower_dg
  [0.259, 1.02, 1.049, 1.011, 1.061, 1.225, 1.111, 1.199, 1.434, 1.676, 1.623, 2.141, 2.018, 2.277, 2.536, 2.794, 3.053], // cap_sp
  [0.197, 1.007, 0.983, 1.006, 1.176, 1.274, 1.165, 1.146, 1.537, 1.865, 2.182, 2.085, 2.215, 2.412, 2.61, 2.807, 3.005], // cap
  [0, 1.115, 1.639, 2.196, 2.817, 1.606, 1.484, 1.484, 1.484, 1.484, 1.484, 1.484, 1.484, 1.484, 1.484, 1.484, 1.484], // cap_dg
  [0.087, 0, 1.33, 1.264, 1.786, 1.476, 1.672, 1.726, 2.196, 2.798, 2.197, 2.284, 2.371, 2.457, 2.544, 2.631, 2.717], // upper_sp
  [0.222, 0, 1.032, 1.192, 1.554, 1.339, 1.295, 1.68, 1.749, 1.92, 2.622, 2.845, 3.067, 3.289, 3.511, 3.734, 3.956], // upper
  [0, 0, 1.304, 1.895, 2.294, 2.983, 3.279, 3.746, 5.285, 5.285, 5.285, 5.285, 5.285, 5.285, 5.285, 5.285, 5.285], // upper_dg
  [0.453, 1.004, 1.064, 1.493, 1.104, 1.001, 0.727, 1.091, 0.976, 0.858, 0.913, 1.366, 1.819, 2.273, 2.726, 3.179, 3.632], // in_cap
  [0.397, 0, 0.726, 1.504, 2.353, 3.017, 3.146, 3.483, 4.211, 4.608, 5.005, 5.402, 5.799, 6.196, 6.593, 6.99, 7.388], // in_upper
];
const SEG_B: number[][] = [
  [0, -0.099, -0.009, 0.106, 0.332, 0.658, 0.864, 1.037, 1.213, 1.395, 1.618, 1.711, 1.902, 2.056, 2.159, 2.159, 2.159], // lower_sp
  [0, 0.002, -0.045, 0.068, 0.066, 0.094, 0.249, 0.247, 0.293, 0.397, 1.28, 1.6, 0.707, 1.506, 1.697, 1.697, 1.697], // lower
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // lower_dg
  [0.013, -0.441, -0.126, 0.181, 0.467, 0.564, 0.909, 1.132, 1.111, 0.906, 1.561, 1.375, 1.891, 1.904, 1.917, 1.93, 1.944], // cap_sp
  [0.118, -0.298, 0.068, 0.358, 0.48, 0.628, 0.902, 0.913, 1.282, 1.091, 1.132, 1.565, 1.537, 1.655, 1.773, 1.891, 2.009], // cap
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // cap_dg
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // upper_sp
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // upper
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // upper_dg
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // in_cap
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // in_upper
];
/** Extra cost of every segment of one letter run beyond the third (random strings such as base64). */
const SEG_EXTRA = 0.186;
/** Digit runs of 1..8 digits: [not after a space, after a space]; DIGIT_SLOPE per digit beyond 8. */
const DIGITS: number[][] = [[0, 1, 1, 1.003, 1.826, 1.978, 2.436, 2.941, 3.194], [0, 1, 1, 1.155, 1.253, 2.062, 2.432, 3.146, 3.535]];
const DIGIT_SLOPE = 0.365;
/**
 * Cost per non-ASCII character class. Classes 1..48: script group x tokens the character needs on its
 * own (1, 2, 3), groups in the order latin, greek, cyrillic, hebrew, arabic, devanagari, indic, thai, han, kana, hangul, symbol, mark, other, emoji, astral;
 * classes 49..96: the Cyrillic letters U+0430..U+045F (upper case folded).
 */
const CLASS_COST: number[] = [
  0, 0.796, 2.24, 0.05, 1.04, 1.897, 2.827, 1, 2.093, 3, 0.821, 1.282,
  3, 0.794, 1.635, 3, 1.03, 1.914, 3, 1.003, 2, 3, 0.726, 1.995,
  3, 0.757, 2.307, 4, 0.78, 2.404, 3, 0.903, 1.931, 2.876, 1.209, 2.256,
  2.986, 1.059, 1.87, 3, 0.122, 2.025, 2.998, 1, 2.385, 2.981, 1, 2,
  3, 0.548, 0.632, 0.595, 0.715, 0.566, 0.357, 0.871, 0.288, 0.623, 0.782, 0.574,
  0.269, 0.638, 0.323, 0.334, 0.553, 0.628, 0.504, 0.365, 0.934, 0.448, 0.733, 0.732,
  0.303, 0.897, 1.561, 1.271, 0.457, 0.309, 0.05, 0.711, 0.638, 1.5, 1.461, 1.5,
  1.5, 1.286, 1.5, 1.42, 1.525, 1.427, 1.589, 0.613, 1.5, 1.5, 1.5, 1.611,
  1.984,
];
/** Added once at the start of a run of non-ASCII characters, per group of its first character: [no space before, after a space]. */
const RUN_START: number[][] = [[0, 0], [0.062, 0.294], [0.69, 0.474], [0.678, 0.849], [0.735, 1.185], [0.068, 0.186], [0.001, 1.005], [0.134, 0.385], [-0.107, 0.839], [-0.265, 0.331], [0.134, 0.059], [-0.259, -0.157], [-0.004, 0.068], [0.093, 0.778], [-0.426, 0.157], [0, 0]];
/** Letter-pair weights of the line profile, 28 x 28 (a-z, letter with diacritic, word boundary), two base-36 digits each. */
const PAIR_MIN = -60;
const PAIR_STEP = 0.09168;
const PAIR_WEIGHTS =
  'i2jchrhtl6jrg8knhmkuj6ibinhyklibjxi9idhrjfi0iqm1gcikk2jmhslmjghzi0lyh5idizf3f0gmlckmi6jvigi6ijkfhkn6' +
  'hyoigzh4kjgpixluijhmiqo5heieiwixhtjxjsnkiuj6kehlhhifj4nubzo1ilk1iyh3iyl2idi6jhl8gamojlhao3jygvk7jigz' +
  'kdiohxjgkmgpghf8halkkfhshojrh6hfibgfhujejzl5kxj4i8i2hzhghxhxi1iql5i9gflzhikuichsioqij8nbjohri3fyhyt8' +
  '9vjdkvilisj6pghokuhqk1maijpqhdd1ixh4lxnwoch0jtl1ijgwl3hgl6jhkej4lpmte8kejpjwjlbvg600oie1pbiwisizf4h3' +
  'isj1lhdaik5notldhyici2o4ffjdkgiyknilguxzib2hl0iojbizhnh6ioiegycwk7jll0jyijhngliaj0j2hsi4mdhti0mvk7gm' +
  'imkwgqbxn4o8kkjgleevljoez3e7odkohliskrxviek6jli1j5r91b0umthrkxlgiekyhrgmf2o9ibk5mdlhmgj9lbisjdlvjrkb' +
  'lhjlk3kjnwnal8jci3ihm1gmhwhvjfhqhozzomj3hyk5gtj6hdhqhdjehohai6j2gllqhnhlibiskdixhwini8n5hzsvnqj5iaj8' +
  'hqi2hjhshjkmh3ewjanmgrjdiji7icnah5ibjdhrh2k6jpluh9jzjtivili5puhni5hsjei0jgpojom9imihi6jcjbi7i6irh6m2' +
  'jfg3jojgiyhxgvijnzhsk0hrijisgtj8k6hyknjghzfql0fei7lcixeehritm5hylhl2hwiqksh4i2igjesehtm6ggqsjahdjof9' +
  'knkvcmpspalq9kkycphrh6lmnxl1p9l6sdi8gtmaey7ubogedehuiglwi4h5ili7h5n6j0oqhdk6hwhrighyl1iwici3jsjqjql4' +
  'gtlsj5i6joi3ihfpicikhmiujajplkl8irj8iuiuhcj6i8i8ibidgyrdhykek0huiok4k0kyivgjj9hbiblyjpiyf2l3hwgmo7i5' +
  'i2jajyj1eom1gqjcjdhxjridh2h7i9k8h7fpj6jiiihnhphvlvhto4gyhwhsoam1k9rrmtkvlojmjl1jo8khinm5hhbdiwbwijja' +
  'l1oekrmfp6m6o4fzlrl79eg3iqdwmcjkkfehjwl7iohglkhjice0irkqk9k9kqmb00hsicozmy4nhq8kiuk6ivi0fxejddozfkfj' +
  'gzende1uhqfhe2f9gudtd9fefndtdseugphke59gdtedljl2khl7kjlqizk5lciqnlkdi4joiokjgajzkdlchghqih00rqjvlfi3' +
  'kvm5l8k9j4myk6nolrmtn8jwmom9mrme7fkginm4ldo5kz00jjnxm7kdieknjwjhlhkog9j2k9n3lhkxlei3dgmbkvk6imialcgf' +
  'h2nzkvhygjilhqizhmhgimhoh7htinibiajcihhsi1iikkhehzhyiihbh6nggghxhvi6';
/**
 * Probability (in 35ths, one base-36 digit) that the tokenizer splits between two adjacent ASCII punctuation
 * characters, 33 x 33 in ASCII order (! " # ... ~, then "control character").
 */
const PUNCT_SPLIT =
  '06suqqgy6vql1y6uq22tqv04pqyxttqyqlg211f9v0d20611017k1k1430d43102eq2k0yot7fzywqiwi5vsywt1vcwqzyqqjqq' +
  'vkz0fxseozu3agzuxsvuzysctvgx3zvyqqrui1vh20uw0c1zx0qwxqutpqvuxxuyqqyx7vq0xzyvqysyvyssessqtdquzsqttsq' +
  '6279153n0hb00180219fo060051b0b5bx0002100300cvxmn0r39t4102qt110zunq7gl7euaa0170403019j62t641a463b7uq' +
  'xayzqqn990s111219z7wnugbcqpz1yyqqq3qooq8aaw09xbfx9u1q7ukfyqyyuxwxqy02vjwaa4lss1ayexsqquqe9yw7yfuqqq' +
  'viyw6y7hx5sa013zwz71wsl3yyzyozysqx2zh7v4x35f0x07o91qztud5is0z4wyyqzchgat6dl0eh180pycz1c03bzz4z0qzeq' +
  'y00y2s4s10i3pb01y10qvn813sx08zvwqt8sxq35yytusxwjuq5wqwxv7yqnztxpqq1xyvkqxuqqtxlx0qq0423yyiqq3wzwtxq' +
  'z1773308yywy0n44x801qy32ysez0qyyqw6zldmdl7bv159889000yzf3dqzh3zzxqw0xxqv5zj1w2t0u2ygy20vmnmsoytwxqq' +
  'u3jtnyuwwqquuxzqvqqyq0vvzvxyvqxtqz0iejy1et3x91ge2qiuqt17p631z0ttqqy6xrzzrlqtx1sb2ztjzlyjz2ot5zo9xwq' +
  '9cxsexa30970t4111b3guq2055hz8cqqqquyyuqxuqdqyrywxvwyqxyk6t4wtsstxqu7vyqw9369v0x2v6j1ltvqu2xq1zeqyqq' +
  'yxyzxyc9hzz0z1z2ezwwzzgkzxd07wyoqs0otkvbzqxqqryz9qzzqqey0ttzy0u0zqxzyiiajhqxq9zyy2yqnxqqhet3uvu0vuq' +
  's1y03t1x2rb1461211ki3zc2tq56y405qqjqqqqxuqqqeq5bwtyqyqqxkvqwxuqz2qqqqqqqqqqqqqqqqqqqqqqqxqqqqqqqqq1';
/**
 * Vocabulary facts (not fitted): BMP characters that are a single token after NFKC, and 64-code-point blocks
 * whose 2-byte UTF-8 prefix is a token (their characters need 2 tokens instead of 3). Run-length coded:
 * "gap" or "gap.extra" in base 36.
 */
const ONE_TOKEN_CHARS =
  '42.2 2 8.3 2.1 1.2 1.1 1.7 1.2 3 1.2 1 1 1 3 5 3 4 2.n 1.6 2 1 1 1 5 3 7 1 3 b 5.2 e 1 8 3.2 5 1 3 1 ' +
  '1 7 3 a 1 1.1 1c m 1.3 10 1 11 1 1r 2c 1.1 3.1 d q.2 4a 5 2 c s.2 1 2.5 1.2 1.1 1 2 6.1 3.1 p.1 3 ' +
  'q.5 1.1 1.b 1 7.w 1 2 1.2 1 ad.1 1.2 1.2 1.1 1 1 1 1 2.3 1o.3 1.3 1.4 1 1 7.9 2m y fp i e 3 5 1 1 ' +
  '5.1 4.2 6.1 2 1 34 s2 h 6 4 2 2i 4 m c6.1 2.1 4 5 3.1 3 1.1 1 d.1 1.2 4.2 1.4 b 3p 3 3 2fn 1 1.1 1.7 ' +
  '1 1.5 3.2 1 1 1.1 1 3.2 2 1.1 1 1.7 e z 1 1 q 3 e6 1c d 2.b 4.1 1.2 2.1 2.6 1.2 5 2 2.1 8 7 2.1 m ' +
  'g.1 2.q 1.3 1.7 b 3 2d 7.4 1.3 1.1 2.4 2.2 1 3 1.3 1.2 1.3 1.1 2.1 7.4 m.6 1.2 1.e 1.3 h.2 3i 4 2 r ' +
  '1a e2.j 1u.1g l.1 1 4 a 7 1g 6 2 2 e j 3 3 3 3.2 d b y 17.1 29 4 m 2r 5j 2x 72 ad.1 4k.1 9r.1 f5 2o ' +
  '5 1 1 4 2 4 5 1 4 1 2 3 1.1 3 7 2.1 1 2.2 1 2 3 3 2 2 8.1 4 2 2.1 3 4 2.1 5.1 5 4 3.1 7.1 7.1 7.1 3 ' +
  '4 3 d 7 19.2 9.1 2.1 12 9 1 1 1 1.3 1 1 1 1 1 1 1 1 1.2 1.1 1.5 2.2 d.1 1.1 1 3.4 2 2.1 e.2 1.2 1.1 ' +
  '1 1.1 2 1 1.2 1 3 3 2.3 7 3.2 6 1.1 3 1 1.4 5 7.1 45.6 4.2 4m a.e e.3 2.2 4 2 1.4 4.1 1 1.2 1.3 8.1 ' +
  '2.6 2 1.1 2.e c.2 1.7 1.4 1 2.1 7 2 1.1 4.4 3b.2 1.1 2 6 1 1.3 5.2 1.1 2.4 1.2 a 3 2.1 1 3 1 5 3.2 ' +
  '2.f 2.1 z 54w 6 1.2 1.1 4.1 5 1 7 5 2 4 1 5.1 c.1 1 4 7 6.1 5 9 l 4.1 1 2.1 1 6 8 2 4 d 5 4 4 3 4 2 ' +
  '1 a.2 6 9.1 3 1 3 m 1 5 r 9 6 5 1 3 2 3 u b f 1 1r 3 c s d a n a i 1 23 12 37 1 2.1 1 p 2 3 4 1.1 ' +
  '1.2 c 6.1 b p 1 g 8 g p.1 a.1 a 4 1 3 b 1 4 5 m p a 14 3.2 6.1 17 1b g.1 x.1 6 8 3 6 1 2 5.1 e 2 i o ' +
  'r 3 2 7 1.1 3 4.2 a.2 4 4.1 2 3.1 b 3.1 2.2 2 k 4 3 q d f k e 1g 6 4 3c 81 36 2 1 1 h 8.1 w 8 7 9 5 ' +
  '6 8 6 1f 1u g q 1i 2 1i n q 2t 2 1 3 8 3 c 1.1 6 2 4 1v 4 20 as 6.1 d q 1 5 2 d 3.1 2 g 2 2 c 1e 2 1 ' +
  '5 1 8 1 2 s c 1 1 c 5 8 i 3i 6k.1 6.1 7 2.1 f.1 y h 1m.1 1 8 6 8 3.1 2 e 2b 5 1 c 5 a o o.1 1 c e ' +
  'i.1 2 3 a m 8 b 1 h 15 r 9 j 1f 1k s 19 r f 6n.2 4 j c 7.1 a 1 5 j 1 f 4.2 9 a f z l 9 2 k 5 1 2d 2 ' +
  'b q 8 i 1.1 12.1 a 1s 40 3l 6 2 4.1 8 g m 3 3 e h j 2 8 l 7 8 4 g l 1 4 b.1 e e 3 17.1 3m 1 a.1 7.1 ' +
  '3 h a 1 2 a 8 r 1 3 p 4 b 6 4 20 x 7 1 f l.2 2 9 1 q 2k 57 5 46 7 73 1s.4 26 n 1 4 1o y 3 9 s.1 1s h ' +
  '7 p c 5 2a 5 9 17 g 2w j 1e t 1l 1s f 2 d0.1 1e 20 1c 5g 9 g.1 3 s f 1o 5s 3 z.1 25 7 7s 8 8 1 1 5 g ' +
  'o 7o.1 1.1 5 24 6 l 5 3 8 9 j w 4k 3 3 5 d 30 5n 3 v 9 2a h 3.1 s.1 a f 32 6 l 1f d 6 e 1i 5 s a 1 ' +
  '13 1 m 9 f 5l 1u 1o 10 1 19 3t 5j 3.1 n 3.1 1 1 6 3 4.1 2 2 7 5 6 x i 13 o 3 1h 2k 1 1 6 1z 5 1y g ' +
  '22 6k 8.1 3h f 1a 1f b h 4z 10 du ho r 1u p 55 1 1r 2 1 1 9 g s 7 10 ab.1 1 4 3.1 1 7 1 3.1 1 2 1 6 ' +
  '7 7 4 2.1 6 1 4 2 3 2 4 2l 2t 2f 3 1.1 1 4 b a 1e d 19 15 h 3 53 3w 19 5 1.1 4 8 5 d 1 11 4 8 8.1 2 ' +
  '3.1 1 2 e 2 c 2.1 7 8 7 4.1 18 5 27 a 1l k 27 3d 2 1.1 1 1 ja 11 1z 7 1 o k 28 b 7 e 1x 4.1 5 6 z ' +
  'i.1 1 f.1 9 h 1 16 4 1d 1b 9 29 b 3 40 3l 3.2 8 c 6 3.1 1s 53 5x v 23 s8 6 3d 1y 1du.1 9f.3 4 sm 3 d ' +
  '9 33 1c y r 33 3v 1j r gb r db 1f r 3 g 6 5f k 1q 3 5b 7 if r 1c y 1k 1i 33 4v 7 13 v 4n 5f 5b 3z ' +
  '2z.1 3u 3 mf 3 g 7 2a k 6 2b 3v 3v g 12.1 h2 1j 1j r r 7 1b r 2b k 6 v 1f 1j 3 3 7 b r 3 3 8 a.1 j 6 ' +
  '2f g 6 67 5f 1j v3 er 5f av in 3 3 8 a k 4u r 3 6ug 2.2 3 q e 2 15 1 3 1.1 2 6 1 7 b 3 d b 9 2 4 3 b ' +
  'g 1 2 3 4 a 2 5 2.1 6 g 3 8 h c 6 8 5 l.1 1 p 8 b 4 1 3 3 f 1p.3 1.1 p.5 1.2 2s.3 2e.1 i.3 en.7 2 ' +
  'm.8 2.1 4.1 4.1 4.5 1.8 2.7 1.3 x.b 4.d 2.f 4.3 4.3 4.z a 2p.4 2 1 2.b 1.4 1 2.1 7 2 1.1 4.4 1 1u.1 ' +
  '2 5.3 f';
const TWO_TOKEN_BLOCKS =
  '10.3 6.2 1 1 1.3 6.1 1.3 19 3.3 4.1 4 1.2 4 4.5 1.3 1.3 8 j.3 38.p 1.3 1.1 1.e 3.6 3.e 1.z 1.j 1.4 ' +
  '2.4 1.2 2.4 1.4 1.g 1.k 1.c 2.1 1 1 2 2.2 1.6 1.b 1.9 1 1 4 5.b 1.4 1.1 2.2 6 6.2 1.1 1d.5 1.2 8.2 ' +
  '5.1 1 1.1 2.1 8.4 1 1.2 1.1 1 2.1 1.2 1 1.1 9.3 1 1.1 9.9 1 3 2 8 1 6 8.2 5 1 2 2 1.2 1.2 4d';
// </fitted-constants>

// ---------------------------------------------------------------------------------------------------------
// Lookup tables, built once when the module is loaded
// ---------------------------------------------------------------------------------------------------------
/** Kind of every UTF-16 code unit. */
const KIND = new Uint8Array(0x10000);
/** Per code unit: letter index 0..25 for letters, punctuation index for punctuation, cost class otherwise. */
const AUX = new Uint8Array(0x10000);
const PAIR = new Float64Array(N_SYM * N_SYM);
const SPLIT = new Float64Array(N_PUNCT * N_PUNCT);
const COST_A = new Float64Array(SEG_A.length * SEG_W);
const COST_B = new Float64Array(SEG_A.length * SEG_W);
const COST_DIGITS = new Float64Array(2 * (DIGIT_LEN + 1));
const COST_CLASS = new Float64Array(N_CLASSES);
const COST_RUN = new Float64Array(N_GROUPS * 2);
const CLASS_GROUP = new Uint8Array(N_CLASSES);

/** Decodes the run-length coded integer sets: tokens are "gap" or "gap.extra" in base 36. */
function decodeRuns(coded: string, visit: (value: number) => void): void {
  let cursor = 0;
  for (const tok of coded.split(' ')) {
    const dot = tok.indexOf('.');
    const start = cursor + parseInt(dot < 0 ? tok : tok.slice(0, dot), 36);
    const len = dot < 0 ? 1 : parseInt(tok.slice(dot + 1), 36) + 1;
    for (let k = 0; k < len; k++) visit(start + k);
    cursor = start + len;
  }
}

function punctIndex(c: number): number {
  if (c >= 0x21 && c <= 0x2f) return c - 0x21;
  if (c >= 0x3a && c <= 0x40) return c - 0x3a + 15;
  if (c >= 0x5b && c <= 0x60) return c - 0x5b + 22;
  if (c >= 0x7b && c <= 0x7e) return c - 0x7b + 28;
  return 32;
}

(function buildTables(): void {
  KIND.fill(K_X);
  for (let c = 0; c < 0x80; c++) {
    if (c === 0x20) KIND[c] = K_SP;
    else if (c === 0x0a) KIND[c] = K_NL;
    else if (c === 0x09 || c === 0x0b || c === 0x0c || c === 0x0d) KIND[c] = K_WS;
    else if (c >= 0x61 && c <= 0x7a) KIND[c] = K_LO;
    else if (c >= 0x41 && c <= 0x5a) KIND[c] = K_UP;
    else if (c >= 0x30 && c <= 0x39) KIND[c] = K_DG;
    else KIND[c] = K_PU;
    AUX[c] = KIND[c] === K_LO || KIND[c] === K_UP ? (c | 0x20) - 97 : KIND[c] === K_PU ? punctIndex(c) : 0;
  }

  const group = new Uint8Array(0x10000);
  for (let i = 0; i < SCRIPT_RANGES.length; i += 3) {
    for (let c = SCRIPT_RANGES[i]; c <= SCRIPT_RANGES[i + 1]; c++) group[c] = SCRIPT_RANGES[i + 2];
  }
  const oneToken = new Uint8Array(0x10000);
  decodeRuns(ONE_TOKEN_CHARS, (c) => {
    oneToken[c] = 1;
  });
  const twoTokenBlock = new Uint8Array(1024);
  decodeRuns(TWO_TOKEN_BLOCKS, (b) => {
    twoTokenBlock[b] = 1;
  });
  for (let c = 0x80; c < 0x10000; c++) {
    // tokens the character needs on its own: 1 if it is in the vocabulary; a 2-byte UTF-8 character is two
    // byte tokens; a 3-byte character is 2 tokens when its 2-byte prefix is a token, else 3
    const alone = oneToken[c] ? 1 : c < 0x800 ? 2 : twoTokenBlock[c >> 6] ? 2 : 3;
    AUX[c] = 1 + group[c] * 3 + (alone - 1);
    if (group[c] === G_LATIN) KIND[c] = K_LX;
  }
  for (let i = 0; i < CYR_COUNT; i++) {
    const lower = CYR_FIRST + i;
    const upper = i < 32 ? lower - 0x20 : lower - 0x50;
    AUX[lower] = AUX[upper] = 1 + N_GENERIC + i;
  }
  // characters that NFKC turns into a plain space, other white space, digits
  KIND[0x00a0] = KIND[0x202f] = KIND[0x205f] = KIND[0x3000] = K_SP;
  for (let c = 0x2000; c <= 0x200a; c++) KIND[c] = K_SP;
  KIND[0x0085] = KIND[0x1680] = KIND[0x2028] = KIND[0x2029] = K_WS;
  KIND[0x00b2] = KIND[0x00b3] = KIND[0x00b9] = K_DG;
  // full-width ASCII variants normalise to ASCII
  for (let c = 0xff01; c <= 0xff5e; c++) {
    KIND[c] = KIND[c - 0xfee0];
    AUX[c] = AUX[c - 0xfee0];
  }
  for (let c = 0xd800; c <= 0xdbff; c++) KIND[c] = K_HS;
  for (let c = 0xdc00; c <= 0xdfff; c++) KIND[c] = K_LS;

  for (let i = 0; i < N_SYM * N_SYM; i++) PAIR[i] = PAIR_MIN + parseInt(PAIR_WEIGHTS.slice(i * 2, i * 2 + 2), 36) * PAIR_STEP;
  for (let i = 0; i < N_PUNCT * N_PUNCT; i++) SPLIT[i] = parseInt(PUNCT_SPLIT.charAt(i), 36) / 35;
  for (let g = 0; g < SEG_A.length; g++) {
    for (let i = 0; i < SEG_W; i++) {
      COST_A[g * SEG_W + i] = SEG_A[g][i];
      COST_B[g * SEG_W + i] = SEG_B[g][i];
    }
  }
  for (let lead = 0; lead < 2; lead++) for (let i = 0; i <= DIGIT_LEN; i++) COST_DIGITS[lead * (DIGIT_LEN + 1) + i] = DIGITS[lead][i];
  for (let c = 0; c < N_CLASSES; c++) {
    COST_CLASS[c] = CLASS_COST[c];
    CLASS_GROUP[c] = c === 0 ? 0 : c > N_GENERIC ? G_CYRILLIC : Math.floor((c - 1) / 3);
  }
  for (let g = 0; g < N_GROUPS; g++) {
    COST_RUN[g * 2] = RUN_START[g][0];
    COST_RUN[g * 2 + 1] = RUN_START[g][1];
  }
})();

/** Row offset into COST_A / COST_B of a finished word segment. `type`: 0 lower, 1 Capitalised, 2 UPPER. */
function segmentRow(len: number, type: number, first: boolean, context: number): number {
  const t = type === 2 && len === 1 ? 1 : type;
  return (first ? t * 3 + context : t === 2 ? SEG_IN_UPPER : SEG_IN_CAP) * SEG_W;
}

/**
 * Estimated number of base units (legacy-tokenizer tokens) in `text`. Integer >= 0.
 *
 * Single pass, O(n) time, O(1) extra memory; no allocation per call.
 */
export function estimateBaseTokens(text: string): number {
  if (typeof text !== 'string') return 0;
  const n = text.length;
  if (n === 0) return 0;

  let total = 0;
  // Latin words of the current line: cost = lineA + z * lineB with z from the letter-pair profile
  let lineA = 0;
  let lineB = 0;
  let lineU = 0;
  let lineN = 0;
  let lead = 0; // 1 when the piece that starts here is preceded by a single attached space
  let afterAlnum = false; // previous piece was a word, a number or a contraction (no space in between)
  let afterDigit = false; // previous piece was a number (no space in between)
  let i = 0;

  while (i < n) {
    const c = text.charCodeAt(i);
    const k = KIND[c];

    if (k <= K_WS) {
      // ---- whitespace run
      let j = i;
      let last = k;
      while (j < n) {
        const kk = KIND[text.charCodeAt(j)];
        if (kk > K_WS) break;
        if (kk === K_NL && lineN > 0) {
          let z = lineU / (lineN + KAPPA);
          z = z < Z_MIN ? Z_MIN : z > Z_MAX ? Z_MAX : z;
          const t = lineA + z * lineB;
          if (t > 0) total += t;
          lineA = lineB = lineU = lineN = 0;
        }
        last = kk;
        j++;
      }
      const len = j - i;
      if (j === n) {
        total += len > 64 ? 2 : 1;
        lead = 0;
      } else {
        // all but the last character form one piece; a final space attaches to the next piece for free
        const head = len - 1;
        let t = head > 0 ? (head > 64 ? 2 : 1) : 0;
        if (last === K_SP) lead = 1;
        else {
          t += 1;
          lead = 0;
        }
        if (t !== 0) total += t;
      }
      afterAlnum = false;
      afterDigit = false;
      i = j;
    } else if (k === K_LO || k === K_UP || k === K_LX) {
      // ---- Latin letter run, cut into case segments
      const context = lead !== 0 ? 0 : afterDigit ? 2 : 1;
      let segLen = 0;
      let segType = 0;
      let first = true;
      let segments = 0;
      let prev = SYM_BOUNDARY;
      let j = i;
      for (; j < n; j++) {
        const cc = text.charCodeAt(j);
        const kk = KIND[cc];
        if (kk !== K_LO && kk !== K_UP && kk !== K_LX) break;
        let sym = SYM_DIACRITIC;
        if (kk === K_LX) total += COST_CLASS[AUX[cc]];
        else sym = AUX[cc];
        lineU += PAIR[prev * N_SYM + sym];
        lineN++;
        prev = sym;
        if (segLen === 0) {
          segType = kk === K_UP ? 2 : 0;
          segLen = 1;
        } else if (kk === K_UP) {
          if (segType === 2) segLen++;
          else {
            const row = segmentRow(segLen, segType, first, context);
            if (segLen <= SEG_LEN) {
              lineA += COST_A[row + segLen];
              lineB += COST_B[row + segLen];
            } else {
              lineA += COST_A[row + SEG_LEN] + COST_A[row] * (segLen - SEG_LEN);
              lineB += COST_B[row + SEG_LEN] + COST_B[row] * (segLen - SEG_LEN);
            }
            first = false;
            segments++;
            segType = 2;
            segLen = 1;
          }
        } else if (segType === 2) {
          if (segLen === 1) {
            segType = 1;
            segLen = 2;
          } else {
            // UPPER run followed by a lower-case letter: its last capital starts a Capitalised segment
            const upperLen = segLen - 1;
            const row = segmentRow(upperLen, 2, first, context);
            if (upperLen <= SEG_LEN) {
              lineA += COST_A[row + upperLen];
              lineB += COST_B[row + upperLen];
            } else {
              lineA += COST_A[row + SEG_LEN] + COST_A[row] * (upperLen - SEG_LEN);
              lineB += COST_B[row + SEG_LEN] + COST_B[row] * (upperLen - SEG_LEN);
            }
            first = false;
            segments++;
            segType = 1;
            segLen = 2;
          }
        } else segLen++;
      }
      const row = segmentRow(segLen, segType, first, context);
      if (segLen <= SEG_LEN) {
        lineA += COST_A[row + segLen];
        lineB += COST_B[row + segLen];
      } else {
        lineA += COST_A[row + SEG_LEN] + COST_A[row] * (segLen - SEG_LEN);
        lineB += COST_B[row + SEG_LEN] + COST_B[row] * (segLen - SEG_LEN);
      }
      segments++;
      lineU += PAIR[prev * N_SYM + SYM_BOUNDARY];
      lineN++;
      if (segments > SEG_FREE) lineA += SEG_EXTRA * (segments - SEG_FREE);
      lead = 0;
      afterAlnum = true;
      afterDigit = false;
      i = j;
    } else if (k === K_DG) {
      // ---- digit run
      let j = i + 1;
      while (j < n && KIND[text.charCodeAt(j)] === K_DG) j++;
      const len = j - i;
      const row = lead * (DIGIT_LEN + 1);
      total += len <= DIGIT_LEN ? COST_DIGITS[row + len] : COST_DIGITS[row + DIGIT_LEN] + DIGIT_SLOPE * (len - DIGIT_LEN);
      lead = 0;
      afterAlnum = true;
      afterDigit = true;
      i = j;
    } else if (k === K_PU) {
      // ---- contraction directly after a word or number: 's 't 'm 'd 're 've 'll are one token
      if (c === 0x27 && afterAlnum && i + 1 < n) {
        const c1 = text.charCodeAt(i + 1);
        const c2 = i + 2 < n ? text.charCodeAt(i + 2) : 0;
        let len = 0;
        if (c1 === 0x73 || c1 === 0x74 || c1 === 0x6d || c1 === 0x64) len = 2;
        else if ((c1 === 0x72 && c2 === 0x65) || (c1 === 0x76 && c2 === 0x65) || (c1 === 0x6c && c2 === 0x6c)) len = 3;
        if (len !== 0) {
          total += 1;
          i += len;
          continue;
        }
      }
      // ---- ASCII punctuation run: 1 token plus the split probability of every adjacent pair
      let t = 1;
      let p = AUX[c];
      let j = i + 1;
      while (j < n) {
        const cc = text.charCodeAt(j);
        if (KIND[cc] !== K_PU) break;
        const q = AUX[cc];
        t += SPLIT[p * N_PUNCT + q];
        p = q;
        j++;
      }
      total += t;
      lead = 0;
      afterAlnum = false;
      afterDigit = false;
      i = j;
    } else {
      // ---- run of other characters (any mix of scripts, symbols, emoji)
      let started = false;
      let j = i;
      while (j < n) {
        const cc = text.charCodeAt(j);
        const kk = KIND[cc];
        let cls = CLASS_LONE_SURROGATE;
        if (kk === K_X) {
          cls = AUX[cc];
          j++;
        } else if (kk === K_HS) {
          const lo = j + 1 < n ? text.charCodeAt(j + 1) : 0;
          if (lo >= 0xdc00 && lo <= 0xdfff) {
            const cp = ((cc - 0xd800) << 10) + (lo - 0xdc00) + 0x10000;
            if (cp >= 0x1f000 && cp <= 0x1faff) {
              // six 64-code-point emoji blocks have a 3-byte prefix token: 2 tokens instead of 3
              const b = cp >> 6;
              cls = b === 0x7cc || b === 0x7d1 || b === 0x7d2 || b === 0x7d4 || b === 0x7d8 || b === 0x7da ? CLASS_EMOJI_2 : CLASS_EMOJI_3;
            } else cls = cp >= 0x20000 && cp <= 0x3ffff ? CLASS_HAN_3 : CLASS_ASTRAL_3;
            j += 2;
          } else j++;
        } else if (kk === K_LS) j++;
        else break;
        if (!started) {
          total += COST_RUN[CLASS_GROUP[cls] * 2 + lead];
          started = true;
        }
        total += COST_CLASS[cls];
      }
      lead = 0;
      afterAlnum = false;
      afterDigit = false;
      i = j;
    }
  }

  if (lineN > 0) {
    let z = lineU / (lineN + KAPPA);
    z = z < Z_MIN ? Z_MIN : z > Z_MAX ? Z_MAX : z;
    const t = lineA + z * lineB;
    if (t > 0) total += t;
  }
  const rounded = Math.round(total);
  return rounded > 0 ? rounded : 0;
}
