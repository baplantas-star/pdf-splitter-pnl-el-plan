import { loadPdf, extractPageText, renderPageToCanvas, PasswordProtectedError, CorruptPdfError } from './pdfText';
import { detectStudentId } from './detectId';
import { ocrStudentId } from './ocr';
import type { DocumentProfile } from './profiles';
import { buildFilenameForProfile } from './profiles';
import type { FileRow } from '../types';

/** @deprecated kept for any external reference; prefer buildFilenameForProfile */
export const FILENAME_PREFIX = '26-27 ETA PNL';

export function buildFilename(studentId: string): string {
  const cleanId = studentId.trim();
  return `${FILENAME_PREFIX} ${cleanId}.pdf`;
}

/**
 * Build a local blob: URL for previewing a row's resulting PDF inline
 * (e.g. in an <iframe> within the page), rather than opening a new tab.
 *
 * An in-page preview was chosen over window.open()/new-tab after testing
 * showed opening a blob: URL in a newly created top-level browsing context
 * is unreliable across Chrome versions/security configurations (the blob
 * registry isn't always accessible from the new context). An inline
 * <iframe> avoids that class of failure entirely, since it renders inside
 * the same document that created the blob -- and it also isn't subject to
 * popup-blocker policy, which is worth avoiding in a district environment
 * where browser lockdown settings are common.
 *
 * Caller is responsible for calling URL.revokeObjectURL(url) when the
 * preview is closed, to release the memory.
 */
export function makePreviewUrl(pdfBytes: ArrayBuffer): string {
  const blob = new Blob([pdfBytes], { type: 'application/pdf' });
  return URL.createObjectURL(blob);
}

const AUTO_READY_THRESHOLD = 0.85; // pdf-text-label matches only
const REVIEW_THRESHOLD = 0.01; // anything with a candidate but below auto-ready

/**
 * Crop a canvas to a region (as fractions of width/height) for faster,
 * more targeted OCR -- we only need the upper portion of page 1 where the
 * student-information box lives.
 */
function cropCanvas(src: HTMLCanvasElement, xFrac: [number, number], yFrac: [number, number]): HTMLCanvasElement {
  const sx = src.width * xFrac[0];
  const sy = src.height * yFrac[0];
  const sw = src.width * (xFrac[1] - xFrac[0]);
  const sh = src.height * (yFrac[1] - yFrac[0]);
  const out = document.createElement('canvas');
  out.width = sw;
  out.height = sh;
  const ctx = out.getContext('2d')!;
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
  return out;
}

/**
 * Mirrors splitPipeline.ts's per-page detection, scoped to a single
 * standalone file rather than a page range within a merged batch. Kept as
 * a separate, self-contained copy rather than a shared import specifically
 * so a change made for one mode can't silently alter behavior in the
 * other -- the duplication is a deliberate, small cost traded for keeping
 * each mode's blast radius contained.
 */
async function detectOnPage(doc: any, pageNumber: number) {
  const { items, pageWidth, pageHeight } = await extractPageText(doc, pageNumber);
  let detection = detectStudentId(items, pageWidth);

  const headerItems = items.filter((it: any) => it.top < pageHeight * 0.35);
  const headerChars = headerItems.reduce((s: number, it: any) => s + it.str.replace(/\s/g, '').length, 0);

  if (!detection.studentId && headerChars <= 40) {
    try {
      const canvas = await renderPageToCanvas(doc, pageNumber, 2.5);
      const cropped = cropCanvas(canvas, [0, 1], [0, 0.35]);
      let ocr = await ocrStudentId(cropped);
      if (!ocr.studentId) ocr = await ocrStudentId(canvas);
      if (ocr.studentId) {
        detection = { studentId: ocr.studentId, method: 'ocr' as any, confidence: ocr.confidence, candidates: [] };
      }
    } catch {
      // fall through with whatever `detection` already holds
    }
  }
  return detection;
}

export async function processFile(file: File, profile: DocumentProfile): Promise<FileRow> {
  const base: FileRow = {
    id: crypto.randomUUID(),
    file,
    originalName: file.name,
    studentId: '',
    newFilename: '',
    method: 'none',
    status: 'no-id',
    confidence: 0,
  };

  if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
    return { ...base, status: 'error', errorMessage: 'Not a PDF file' };
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch (e: any) {
    return { ...base, status: 'error', errorMessage: 'Could not read file' };
  }

  let loaded;
  try {
    loaded = await loadPdf(bytes.slice(0)); // slice: pdf.js may detach/transfer the buffer
  } catch (e: any) {
    if (e instanceof PasswordProtectedError) {
      return { ...base, pdfBytes: bytes, status: 'error', errorMessage: 'Password-protected PDF' };
    }
    if (e instanceof CorruptPdfError) {
      return { ...base, pdfBytes: bytes, status: 'error', errorMessage: 'Corrupted or unreadable PDF' };
    }
    return { ...base, pdfBytes: bytes, status: 'error', errorMessage: 'Failed to open PDF' };
  }

  // A file whose page count doesn't match this profile's expectation is
  // very likely the wrong kind of input for this mode entirely -- most
  // commonly, a whole merged batch dropped into "Rename individual PDFs"
  // by mistake. Reading only page 1 of such a file (the old behavior)
  // could silently name the *entire* multi-student batch after whichever
  // student happened to be first, while still attaching every other
  // student's pages to that one filename. Blocking outright, rather than
  // guessing, is the safe default here.
  if (loaded.numPages !== profile.pagesPerStudent) {
    return {
      ...base,
      pdfBytes: bytes,
      status: 'error',
      errorMessage: `This file has ${loaded.numPages} page${loaded.numPages === 1 ? '' : 's'}; ${profile.label} is expected to be ${profile.pagesPerStudent} page${profile.pagesPerStudent === 1 ? '' : 's'}. This may be a merged batch -- use the Split tab instead, or confirm this is the right document type.`,
    };
  }

  // --- Detection across every page of this file, not just the first ---
  // For a multi-page profile (e.g. the 2-page PNL), a file whose pages
  // disagree on the Student ID is exactly as risky here as it is in Split
  // mode -- it means this "individual" file may not actually belong to a
  // single student. The same disagreement handling applies.
  const detections: { studentId: string; method: string; confidence: number }[] = [];
  for (let p = 1; p <= loaded.numPages; p++) {
    try {
      const d = await detectOnPage(loaded.doc, p);
      detections.push(d);
    } catch (e: any) {
      detections.push({ studentId: '', method: 'none', confidence: 0 });
    }
  }

  const withId = detections.filter((d) => d.studentId);
  const distinctIds = [...new Set(withId.map((d) => d.studentId))];

  let studentId = '';
  let method: FileRow['method'] = 'none';
  let confidence = 0;
  let disagreementWarning: string | undefined;

  if (distinctIds.length === 1) {
    const best = withId.reduce((a, b) => (b.confidence > a.confidence ? b : a));
    studentId = best.studentId;
    method = best.method as FileRow['method'];
    confidence = best.confidence;
  } else if (distinctIds.length > 1) {
    const best = withId.reduce((a, b) => (b.confidence > a.confidence ? b : a));
    studentId = best.studentId;
    method = best.method as FileRow['method'];
    confidence = Math.min(best.confidence, 0.4);
    disagreementWarning = `This file's pages show different Student IDs (${distinctIds.join(', ')}) -- please confirm.`;
  }

  let status: FileRow['status'];
  if (!studentId) {
    status = 'no-id';
  } else if (disagreementWarning) {
    status = 'needs-review';
  } else if (method === 'pdf-text-label' && confidence >= AUTO_READY_THRESHOLD) {
    status = 'ready';
  } else {
    status = 'needs-review';
  }

  return {
    ...base,
    pdfBytes: bytes,
    studentId,
    newFilename: studentId ? buildFilenameForProfile(profile, studentId) : '',
    method,
    status,
    confidence,
    errorMessage: disagreementWarning,
  };
}
