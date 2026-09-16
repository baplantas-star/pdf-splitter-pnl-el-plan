import type { TextItem } from '../types';

export interface DetectionResult {
  studentId: string;
  method: 'pdf-text-label' | 'positional' | 'none';
  confidence: number; // 0-1
  candidates: string[];
}

// PNLs are sent home in translation, but the underlying MD ELD template
// layout stays the same across languages -- only the label text changes.
//
// These patterns were built and verified against real official MCPS
// translated PNL templates (not guessed translations) -- extracted via the
// same pdf.js + x0-ascending-sort logic this file uses, so what's matched
// here is what the real extraction actually produces, including RTL word-
// order quirks (e.g. Urdu's embedded Latin "ID" token extracts BEFORE the
// Urdu words that logically precede it, because it's LTR text embedded in
// an RTL line). Several of these replaced earlier best-guess translations
// that turned out to use different real-world wording once checked against
// the actual documents -- e.g. Spanish's real label is "Núm. del
// estudiante", not "Número de Identificación del Estudiante"; Amharic and
// Russian's real labels omit the trailing "number/ID" word entirely.
//
// One real, unfixable-by-regex limitation found this way: the Dari (fa-af)
// template's entire name/ID header row is not extractable text at all in
// either pdf.js or pdfplumber -- likely a rasterized table region -- so
// Dari requires the OCR fallback path; no label pattern can help it.
//
// NOTE: this block is reassembled from the build conversation record. If
// you have real (redacted) sample PDFs in any of these languages, spot-check
// against them and swap in the exact phrase where it differs -- that was the
// original verification workflow and it caught real mismatches before.
const LABEL_PATTERNS = [
  // English
  /student\s*id\s*:?/i,
  /student\s*number\s*:?/i,
  /student\s*#\s*:?/i,
  /student\s*no\.?\s*:?/i,
  // MCPS-specific ID label, distinct from "Student ID" -- appears on the
  // EML Accommodations Plan (MCPS Form 320-53) rather than the PNL's
  // wording. The form's "SASID #" field is a separate, differently-worded
  // label ("SASID", not "MCPS ID"), so no special-casing is needed to
  // avoid confusing the two.
  /mcps\s*id\s*#?\s*:?/i,
  // Spanish (real: "Núm. del estudiante")
  /n[uú]m\.?\s*del?\s*estudiante\s*:?/i,
  /identificaci[oó]n\s*del?\s*estudiante\s*:?/i,
  /n[uú]mero\s*de\s*(identificaci[oó]n\s*)?(del?\s*)?estudiante\s*:?/i,
  // French (real: "Identifiant de l'élève")
  /identifiant\s*de\s*l[’'‘]([ée]l[eè]ve|étudiant)\s*:?/i,
  /num[eé]ro\s*d[’'‘]identification\s*de\s*l[’'‘]([ée]l[eè]ve|étudiant)\s*:?/i,
  // Portuguese (real: "Identificação do(a) estudante")
  /identifica[cç][aã]o\s*do\(?a?\)?\s*estudante\s*:?/i,
  /n[uú]mero\s*de\s*identifica[cç][aã]o\s*do\s*aluno\s*:?/i,
  // Vietnamese (real: "Mã Số Học Sinh")
  /m[aã]\s*s[ốo]\s*h[ọo]c\s*sinh\s*:?/i,
  /s[ốo]\s*id\s*h[ọo]c\s*sinh\s*:?/i,
  // Chinese Simplified & Traditional (real: "学生 ID" -- keeps Latin "ID")
  /学生\s*id\s*:?/i,
  /學生\s*id\s*:?/i,
  /学生(证|身份证)?号(码)?[:：]?/,
  /學生(證|身份證)?號(碼)?[:：]?/,
  // Korean (real: "학생번호", no space)
  /학생\s*번호\s*:?/i,
  /학생\s*(아이디|id)\s*:?/i,
  // Russian (real: "Идентификационный номер", no trailing "ученика")
  /идентификационный\s*номер(\s*учени[кц]а)?\s*:?/i,
  // Haitian Creole
  /nimewo\s*idantifikasyon\s*(el[eè]v(e)?)\s*:?/i,
  // Arabic
  /رقم\s*(هوية|تعريف)\s*الطالب\s*:?/,
  // Amharic (real omits trailing "number")
  /የተማሪ\s*መታወቂያ(\s*ቁጥር)?\s*:?/,
  // Urdu / Dari / Farsi
  /طالب\s*علم\s*کا\s*شناختی\s*نمبر\s*:?/,
  /شماره\s*شناسایی\s*دانش[- ]?آموز\s*:?/,
  // Tagalog
  /numero\s*ng\s*id\s*ng\s*estudyante\s*:?/i,
  // Yoruba
  /n[oó]mba\s*id\s*akẹ[ḳk]ọ[oọ]\s*:?/i,
  // Hindi / Nepali (Devanagari)
  /व[िी]?द्यार्थ[िी]\s*(पहचान|आईडी)\s*(संख्या)?\s*:?/,
  // Bengali
  /শিক্ষার্থীর?\s*(পরিচয়|আইডি)\s*(নম্বর)?\s*:?/,
  // Burmese
  /ကျောင်းသား\s*အမှတ်\s*:?/,
  // Generic English fallback, lowest priority, checked last. Word-boundary
  // guarded so it doesn't match inside unrelated foreign words (e.g.
  // Haitian Creole "Idantifikasyon"), which was a real bug caught during
  // testing against actual translated documents.
  /\bid\b\s*:?/i,
];

// Context words that suggest a nearby number is something OTHER than the
// Student ID (dates, phone numbers, zip codes, grade levels, proficiency
// scores, page numbers) -- across the same set of languages as the labels
// above. Best-effort; extend with real translated samples as they turn up.
const EXCLUSION_CONTEXT_WORDS =
  /(date|dob|birth|school year|phone|zip|grade|access|proficiency|page)/i;

const EXCLUSION_CONTEXT_WORDS_INTL = new RegExp(
  [
    // Spanish
    'fecha', 'tel[eé]fono', 'c[oó]digo postal', 'grado', 'p[aá]gina', 'nacimiento',
    // French
    'date de naissance', 't[eé]l[eé]phone', 'code postal', 'niveau', 'page',
    // Portuguese
    'data de nascimento', 'telefone', 'cep', 's[eé]rie', 'p[aá]gina',
    // Vietnamese
    'ngày sinh', 'điện thoại', 'mã bưu điện', 'lớp', 'trang',
    // Chinese
    '出生日期', '电话', '邮编', '年级', '頁',
    // Korean
    '생년월일', '전화번호', '우편번호', '학년', '페이지',
    // Russian
    'дата рождения', 'телефон', 'индекс', 'класс', 'страница',
    // Arabic / Urdu / Dari / Farsi (shared script, similar vocabulary)
    'تاريخ الميلاد', 'الهاتف', 'الرمز البريدي', 'الصف',
    'تاریخ پیدائش', 'فون',
    // Amharic
    'የትውልድ ቀን', 'ስልክ',
    // Hindi / Nepali
    'जन्म तिथि', 'फोन',
    // Bengali
    'জন্ম তারিখ', 'ফোন',
  ].join('|'),
  'i'
);

function matchesExclusionContext(ctx: string): boolean {
  return EXCLUSION_CONTEXT_WORDS.test(ctx) || EXCLUSION_CONTEXT_WORDS_INTL.test(ctx);
}

// If a decoy-context word appears on the line, only override the exclusion
// (i.e. still treat a number as a candidate ID) when the line ALSO contains
// an actual "student id" label in some supported language.
const STUDENT_ID_LABEL_ON_LINE = new RegExp(
  [
    'student\\s*(id|number|#|no)',
    'estudiante', // Spanish/Portuguese "student"
    "[ée]l[eè]ve|étudiant", // French
    'aluno',
    'học sinh',
    '学[生号]', '學[生號]',
    '학생',
    'учени[кц]а|идентификационный',
    'elèv',
    'الطالب',
    'ተማሪ',
    'estudyante',
    'व[िी]द्यार्थ[िी]',
    'শিক্ষার্থী',
    'ကျောင်းသား',
  ].join('|'),
  'i'
);

const MIN_ID_LEN = 4;
const MAX_ID_LEN = 10;

interface CharPos {
  ch: string;
  x: number;
}

interface Line {
  top: number;
  bottom: number;
  chars: CharPos[];
  text: string; // == chars.map(c => c.ch).join(''), kept in lockstep for index alignment
}

/**
 * Estimate the x-position of each character within a text item, assuming
 * uniform advance width. This isn't exact glyph metrics, but it's enough to
 * bucket characters into columns, which is all the detector needs.
 */
function charPositions(item: TextItem): CharPos[] {
  const n = item.str.length;
  if (n === 0) return [];
  const w = item.x1 - item.x0;
  const step = w / n;
  const out: CharPos[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ ch: item.str[i], x: item.x0 + step * i });
  }
  return out;
}

function groupIntoLines(items: TextItem[]): Line[] {
  const sorted = [...items].sort((a, b) => a.top - b.top || a.x0 - b.x0);
  const rough: { top: number; bottom: number; items: TextItem[] }[] = [];
  const TOL = 3;

  for (const item of sorted) {
    const mid = (item.top + item.bottom) / 2;
    let line = rough.find((l) => Math.abs((l.top + l.bottom) / 2 - mid) < TOL);
    if (!line) {
      line = { top: item.top, bottom: item.bottom, items: [] };
      rough.push(line);
    }
    line.items.push(item);
    line.top = Math.min(line.top, item.top);
    line.bottom = Math.max(line.bottom, item.bottom);
  }

  const lines: Line[] = rough.map((l) => {
    l.items.sort((a, b) => a.x0 - b.x0);
    const chars: CharPos[] = [];
    let prevX1: number | null = null;
    for (const item of l.items) {
      // Insert a synthetic space between items that have a visible gap, so
      // "Student ID" + "445566" (two items) reads the same as one item that
      // happened to contain "Student ID 445566" -- keeps text/char arrays
      // in lockstep either way.
      if (prevX1 !== null && item.x0 - prevX1 > 2) {
        chars.push({ ch: ' ', x: prevX1 });
      }
      chars.push(...charPositions(item));
      prevX1 = item.x1;
    }
    return { top: l.top, bottom: l.bottom, chars, text: chars.map((c) => c.ch).join('') };
  });

  return lines.sort((a, b) => a.top - b.top);
}

function stripFiller(s: string): string {
  return s.replace(/[_\s.\-•]/g, '');
}

function textInColumn(line: Line, xMin: number, xMax: number): string {
  return line.chars
    .filter((c) => c.x >= xMin - 2 && c.x <= xMax + 2)
    .map((c) => c.ch)
    .join('');
}

/**
 * Find the digit run(s) in a column of text, preferring the one nearest to
 * the label (leftmost in the search direction) over the longest, and never
 * merging two whitespace-separated fields into one number.
 *
 * Two real bugs, both found by an external technical audit and confirmed
 * against this code before fixing, drove this design:
 *
 * 1. The previous version stripped ALL whitespace from the whole column
 *    before searching for digits, which silently merged two separate
 *    fields sitting next to each other into one number (e.g. a "445566"
 *    field followed by an unrelated "07" happened to concatenate into
 *    "44556607"). Splitting into whitespace-delimited tokens first, and
 *    only stripping filler characters (underscores, dots, dashes) *within*
 *    a token, fixes this while still correctly collapsing a single
 *    fill-in-the-blank field like "_4_4_5_5_6_6_" into "445566".
 * 2. The previous version picked the *longest* digit run in the whole
 *    column, so a long neighboring number (e.g. a 10-digit SASID sitting
 *    within the same generously-sized search column as a 6-digit Student
 *    ID) could be selected over the correct, nearer one. Processing tokens
 *    in their natural left-to-right order and taking the first valid one
 *    means "nearest to the label" wins instead of "longest," which is the
 *    behavior actually wanted.
 *
 * Also checks each token for a date shape *before* stripping separators,
 * since a hyphenated date like "09-08-2016" only looks like a date while
 * the hyphens are still there -- stripping first and checking after (the
 * old order) let dates slip through as false ID candidates.
 */
function bestDigitRun(raw: string): { id: string; ambiguous: boolean } | null {
  const tokens = raw.split(/\s+/).filter(Boolean);
  const candidates: string[] = [];

  for (const token of tokens) {
    if (looksLikeDateShape(token)) continue;
    const cleaned = token.replace(/[_.\-•]/g, '');
    const runs = cleaned.match(/\d+/g);
    if (!runs) continue;
    for (const r of runs) {
      if (r.length >= MIN_ID_LEN && r.length <= MAX_ID_LEN) candidates.push(r);
    }
  }

  if (candidates.length === 0) return null;
  const distinct = [...new Set(candidates)];
  return { id: candidates[0], ambiguous: distinct.length > 1 };
}

function looksLikeDateShape(token: string): boolean {
  return /^\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}$/.test(token);
}

function looksLikeExcludedValue(raw: string, context: string): boolean {
  const ctx = context.toLowerCase();
  if (/^(19|20)\d{2}$/.test(raw)) return true;
  if (matchesExclusionContext(ctx)) {
    if (!STUDENT_ID_LABEL_ON_LINE.test(ctx)) return true;
  }
  return false;
}

export function detectStudentId(items: TextItem[], pageWidth: number): DetectionResult {
  const lines = groupIntoLines(items);
  const candidates: string[] = [];

  // Every high-confidence label match found on the page, collected rather
  // than returned immediately -- lets us notice when two different labels
  // (or the same label appearing twice) point to two different numbers,
  // which is a real ambiguity worth flagging rather than silently trusting
  // whichever one happened to be scanned first.
  const labelMatches: { id: string; confidence: number }[] = [];

  for (const pattern of LABEL_PATTERNS) {
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const match = pattern.exec(line.text);
      if (!match) continue;

      // Use the char array to find exactly where the label text ends, even
      // when the label and its value came from the same underlying text
      // item (e.g. "Student ID: 445566" drawn as one string).
      const labelStartIdx = match.index;
      const labelEndIdx = match.index + match[0].length; // exclusive
      const xMin = line.chars[labelStartIdx]?.x ?? 0;
      const xMaxLabelEnd =
        labelEndIdx < line.chars.length ? line.chars[labelEndIdx].x : (line.chars[line.chars.length - 1]?.x ?? xMin) + 8;

      const colMin = xMin - 5;
      // Bound the search column tightly: at most 250 units past the label,
      // and never past the page edge. This used to take whichever of those
      // two was LARGER, which meant the column routinely reached almost to
      // the far edge of the page -- easily wide enough to sweep in an
      // unrelated neighboring field (e.g. a SASID sitting in the same
      // header row as the Student ID). Taking the smaller of the two
      // keeps the search close to the label it's actually attached to.
      const colMax = Math.min(xMaxLabelEnd + 250, pageWidth - 20);

      // Same-row value: whatever comes after the label on this line.
      const sameRowVal = textInColumn(line, xMaxLabelEnd, colMax);
      const sameRowResult = bestDigitRun(sameRowVal);
      if (sameRowResult && !looksLikeExcludedValue(sameRowResult.id, line.text)) {
        candidates.push(sameRowResult.id);
        labelMatches.push({
          id: sameRowResult.id,
          confidence: sameRowResult.ambiguous ? 0.6 : 0.95,
        });
        continue;
      }

      // Row above (fill-in-the-blank above the label, as in the real PNL template)
      const rowAbove = lines[li - 1];
      if (rowAbove && line.top - rowAbove.bottom < 25) {
        const val = textInColumn(rowAbove, colMin, colMax);
        const result = bestDigitRun(val);
        if (result && !looksLikeExcludedValue(result.id, rowAbove.text)) {
          candidates.push(result.id);
          labelMatches.push({ id: result.id, confidence: result.ambiguous ? 0.55 : 0.9 });
          continue;
        }
      }

      // Row below (fill-in-the-blank below the label)
      const rowBelow = lines[li + 1];
      if (rowBelow && rowBelow.top - line.bottom < 25) {
        const val = textInColumn(rowBelow, colMin, colMax);
        const result = bestDigitRun(val);
        if (result && !looksLikeExcludedValue(result.id, rowBelow.text)) {
          candidates.push(result.id);
          labelMatches.push({ id: result.id, confidence: result.ambiguous ? 0.5 : 0.85 });
          continue;
        }
      }
    }
  }

  if (labelMatches.length > 0) {
    const distinctIds = new Set(labelMatches.map((m) => m.id));
    const best = labelMatches.reduce((a, b) => (b.confidence > a.confidence ? b : a));
    // More than one distinct ID surfaced across every label match found on
    // this page (whether from the same label appearing twice, or two
    // different labels) -- that's a real disagreement, not just a single
    // ambiguous field, so it's held below the auto-ready threshold
    // regardless of how confident the best individual match looked.
    const confidence = distinctIds.size > 1 ? Math.min(best.confidence, 0.6) : best.confidence;
    return { studentId: best.id, method: 'pdf-text-label', confidence, candidates };
  }

  // --- Method 2: location-aware numeric detection (no reliable label match) ---
  const pageBottomEstimate = lines[lines.length - 1]?.bottom ?? 1000;
  const scored: { id: string; score: number }[] = [];

  for (const line of lines) {
    // Strip underscores/dots/dashes before hunting for digit runs -- some
    // real PNL templates carry an identifier stamp formatted like
    // "_6_5_6_2_5_1________" (a fill-in-the-blank line with a digit between
    // each underscore), unrelated to any "Student ID" label on the page.
    // Matching \d{4,10} against the raw text finds nothing, because every
    // digit there is isolated by an underscore; stripping filler characters
    // first (as bestDigitRun already does for Method 1) collapses it back
    // to a contiguous, matchable run. Confirmed against a real 20-language
    // test batch, where this was the entire cause of an intermittent
    // "No ID found" pattern -- some units happened to succeed via Method 1
    // (which already stripped filler), the rest silently failed here.
    const strippedLineText = stripFiller(line.text);
    const lineDigits = strippedLineText.match(/\d{4,10}/g);
    if (!lineDigits) continue;
    for (const d of lineDigits) {
      if (looksLikeExcludedValue(d, line.text)) continue;
      candidates.push(d);
      const inUpperHalf = line.top < pageBottomEstimate * 0.6;
      const avgX = line.chars.reduce((s, c) => s + c.x, 0) / Math.max(line.chars.length, 1);
      const rightSide = avgX > pageWidth * 0.45;
      let score = 0.3;
      if (inUpperHalf) score += 0.15;
      if (rightSide) score += 0.15;
      if (d.length >= 5 && d.length <= 8) score += 0.1;
      scored.push({ id: d, score });
    }
  }

  if (scored.length > 0) {
    scored.sort((a, b) => b.score - a.score);
    const top = scored[0];
    return {
      studentId: top.id,
      method: 'positional',
      confidence: Math.min(top.score, 0.65),
      candidates,
    };
  }

  return { studentId: '', method: 'none', confidence: 0, candidates };
}
