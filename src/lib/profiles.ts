/**
 * A "document profile" captures the two things that differ between letter
 * types processed by this tool: how many pages each student's document
 * spans, and the filename convention to apply once the Student ID is
 * found. Student ID *detection* itself (label patterns, positional
 * fallback, OCR) stays shared across all profiles -- the detection engine
 * is generic; only these two facts vary per document type.
 */
export interface DocumentProfile {
  id: string;
  label: string; // shown in the profile picker (full name)
  shortLabel: string; // shown in compact UI text like dropzone hints
  pagesPerStudent: number;
  filenamePrefix: string;
}

export const DOCUMENT_PROFILES: DocumentProfile[] = [
  {
    id: 'pnl',
    label: 'PNL (Parent Notification Letter)',
    shortLabel: 'PNL',
    pagesPerStudent: 2,
    filenamePrefix: '26-27 ETA PNL',
  },
  {
    id: 'eml-plan',
    label: 'EL Plan (Accommodations Plan)',
    shortLabel: 'EL Plan',
    pagesPerStudent: 1,
    filenamePrefix: '26-27 ETA EML PLAN',
  },
];

export const DEFAULT_PROFILE_ID = 'pnl';

export function getProfile(id: string): DocumentProfile {
  return DOCUMENT_PROFILES.find((p) => p.id === id) ?? DOCUMENT_PROFILES[0];
}

export function buildFilenameForProfile(profile: DocumentProfile, studentId: string): string {
  return `${profile.filenamePrefix} ${studentId.trim()}.pdf`;
}

/**
 * Sanitize a manually-typed Student ID before it's used to build a
 * filename or a ZIP archive entry name. Strips anything that isn't a
 * letter, digit, or hyphen -- in particular this removes path separators
 * (/ and \), colons, and other filename-reserved characters, so a stray
 * keystroke can't produce something like "../123:456" ending up as a
 * literal (and unsafe) filename or archive path. Real MCPS/Student IDs
 * seen so far have all been purely numeric, but this doesn't assume a
 * fixed length or digit-only format -- it only removes characters that
 * are never legitimately part of an ID and are specifically dangerous in
 * a filename.
 */
export function sanitizeManualId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9-]/g, '');
}

/**
 * A single uniform description format, derived from each profile's actual
 * page count and filename prefix rather than a separately hand-written
 * string per profile -- this way the description shown in the UI can
 * never drift out of sync with what the profile actually does.
 * e.g. "PNL (Parent Notification Letter) 2 Pages : 26-27 ETA PNL [Student ID].pdf"
 */
export function describeProfile(profile: DocumentProfile): string {
  const pageWord = profile.pagesPerStudent === 1 ? 'Page' : 'Pages';
  return `${profile.label} \u2014 ${profile.pagesPerStudent} ${pageWord} : ${profile.filenamePrefix} [Student ID].pdf`;
}
