import { PDFDocument } from 'pdf-lib';
import { loadPdf, extractPageText, renderPageToCanvas, PasswordProtectedError, CorruptPdfError } from './pdfText';
import { detectStudentId } from './detectId';
import { ocrStudentId } from './ocr';
import type { DocumentProfile } from './profiles';
import { buildFilenameForProfile } from './profiles';
import type { DetectionMethod, SplitRow } from '../types';

const AUTO_READY_THRESHOLD = 0.85;

export interface SplitBatchResult {
  rows: SplitRow[];
  totalPages: number;
  pagesPerStudent: number;
  oddPageCountWarning: boolean;
}

function cropTop(src: HTMLCanvasElement, frac: number): HTMLCanvasElement {
  const sh = src.height * frac;
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = sh;
  const ctx = out.getContext('2d')!;
  ctx.drawImage(src, 0, 0, src.width, sh, 0, 0, src.width, sh);
  return out;
}

/**
 * Mirrors the per-file pipeline's logic, just scoped to one page instead
 * of "page 1 of this file". Skips OCR when the page already has
 * substantial embedded text in its upper (header) region -- see
 * pipeline.ts for why.
 */
async function detectOnPage(doc: any, pageNumber: number) {
  const { items, pageWidth, pageHeight } = await extractPageText(doc, pageNumber);
  let detection = detectStudentId(items, pageWidth);

  const headerItems = items.filter((it: any) => it.top < pageHeight * 0.35);
  const headerChars = headerItems.reduce((s: number, it: any) => s + it.str.replace(/\s/g, '').length, 0);

  if (!detection.studentId && headerChars <= 40) {
    try {
      const canvas = await renderPageToCanvas(doc, pageNumber, 2.5);
      const cropped = cropTop(canvas, 0.35);
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

/**
 * Split one merged PDF into fixed-size (default 2-page) student units.
 *
 * Detection runs on every page of each unit (not just the first), and if
 * two pages in the same unit disagree on a high-confidence Student ID,
 * that's treated as a signal the fixed-page-count assumption broke for
 * this unit (an extra/missing page, a misordered batch, etc.) -- the unit
 * is flagged for manual review rather than silently split under a
 * possibly-wrong name.
 */
export async function splitBatchPdf(file: File, profile: DocumentProfile): Promise<SplitBatchResult> {
  const pagesPerStudent = profile.pagesPerStudent;
  const bytes = await file.arrayBuffer();

  let loaded;
  try {
    loaded = await loadPdf(bytes.slice(0));
  } catch (e: any) {
    const msg =
      e instanceof PasswordProtectedError
        ? 'Password-protected PDF'
        : e instanceof CorruptPdfError
        ? 'Corrupted or unreadable PDF'
        : 'Failed to open PDF';
    return {
      rows: [
        {
          id: crypto.randomUUID(),
          pageStart: 1,
          pageEnd: 1,
          studentId: '',
          newFilename: '',
          method: 'none',
          confidence: 0,
          status: 'error',
          warning: msg,
        },
      ],
      totalPages: 0,
      pagesPerStudent,
      oddPageCountWarning: false,
    };
  }

  const totalPages = loaded.numPages;
  const oddPageCountWarning = totalPages % pagesPerStudent !== 0;

  // Keep the original bytes around so pdf-lib can copy pages without
  // re-fetching or re-parsing from scratch for every unit.
  const srcDocForCopy = await PDFDocument.load(bytes.slice(0));

  const rows: SplitRow[] = [];
  let pageStart = 1;

  // eslint-disable-next-line no-constant-condition
  while (pageStart <= totalPages) {
    const pageEnd = Math.min(pageStart + pagesPerStudent - 1, totalPages);
    const isFullUnit = pageEnd - pageStart + 1 === pagesPerStudent;

    // Detect on every page in the unit.
    const detections = [];
    for (let p = pageStart; p <= pageEnd; p++) {
      detections.push(await detectOnPage(loaded.doc, p));
    }

    const withId = detections.filter((d) => d.studentId);
    const distinctIds = [...new Set(withId.map((d) => d.studentId))];

    let studentId = '';
    let method: DetectionMethod = 'none';
    let confidence = 0;
    let warning: string | undefined;
    let pagesDisagree = false;

    if (distinctIds.length === 1) {
      const best = withId.reduce((a, b) => (b.confidence > a.confidence ? b : a));
      studentId = best.studentId;
      method = best.method as DetectionMethod;
      confidence = best.confidence;
    } else if (distinctIds.length > 1) {
      // pages disagree -- don't guess, surface both for manual resolution
      const best = withId.reduce((a, b) => (b.confidence > a.confidence ? b : a));
      studentId = best.studentId;
      method = best.method as DetectionMethod;
      confidence = Math.min(best.confidence, 0.4);
      warning = `Pages ${pageStart}-${pageEnd} show different Student IDs (${distinctIds.join(', ')}) -- please confirm.`;
      pagesDisagree = true;
    }

    if (!isFullUnit) {
      warning = warning
        ? `${warning} Also: only ${pageEnd - pageStart + 1} page(s) remained, expected ${pagesPerStudent}.`
        : `Only ${pageEnd - pageStart + 1} page(s) remained here, expected ${pagesPerStudent} -- batch page count may be off.`;
    }

    // Build the split-out PDF bytes for this unit.
    const outDoc = await PDFDocument.create();
    const pageIndices = [];
    for (let p = pageStart; p <= pageEnd; p++) pageIndices.push(p - 1);
    const copied = await outDoc.copyPages(srcDocForCopy, pageIndices);
    copied.forEach((pg) => outDoc.addPage(pg));
    const pdfBytes = await outDoc.save();

    let status: SplitRow['status'];
    if (!studentId) status = 'no-id';
    else if (warning) status = 'needs-review';
    else if (method === 'pdf-text-label' && confidence >= AUTO_READY_THRESHOLD) status = 'ready';
    else status = 'needs-review';

    rows.push({
      id: crypto.randomUUID(),
      pageStart,
      pageEnd,
      studentId,
      newFilename: studentId ? buildFilenameForProfile(profile, studentId) : '',
      method,
      confidence,
      status,
      warning,
      pagesDisagree,
      pdfBytes: pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength) as ArrayBuffer,
    });

    pageStart = pageEnd + 1;
  }

  return { rows, totalPages, pagesPerStudent, oddPageCountWarning };
}
