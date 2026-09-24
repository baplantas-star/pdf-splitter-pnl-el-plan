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

type PageDetection = {
  studentId: string;
  method: DetectionMethod;
  confidence: number;
  candidates?: unknown[];
};

type PageRange = {
  pageStart: number;
  pageEnd: number;
};

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
async function detectOnPage(doc: any, pageNumber: number): Promise<PageDetection> {
  const { items, pageWidth, pageHeight } = await extractPageText(doc, pageNumber);
  let detection = detectStudentId(items, pageWidth) as PageDetection;

  const headerItems = items.filter((it: any) => it.top < pageHeight * 0.35);
  const headerChars = headerItems.reduce((s: number, it: any) => s + it.str.replace(/\s/g, '').length, 0);

  if (!detection.studentId && headerChars <= 40) {
    try {
      const canvas = await renderPageToCanvas(doc, pageNumber, 2.5);
      const cropped = cropTop(canvas, 0.35);
      let ocr = await ocrStudentId(cropped);
      if (!ocr.studentId) ocr = await ocrStudentId(canvas);
      if (ocr.studentId) {
        detection = {
          studentId: ocr.studentId,
          method: 'ocr',
          confidence: ocr.confidence,
          candidates: [],
        };
      }
    } catch {
      // fall through with whatever `detection` already holds
    }
  }

  return detection;
}

/**
 * Build student page ranges from Student-ID anchors instead of blindly
 * chopping the batch into fixed-size chunks.
 *
 * The profile's pagesPerStudent remains the minimum/normal unit size.
 * Once that many pages have accumulated, a DIFFERENT Student ID starts a
 * new student. Repeating the SAME Student ID later keeps the pages
 * together, which is what lets a standard 2-page PNL plus its adjacent
 * 2-page translation become one 4-page output PDF.
 *
 * If the first expected unit has no detectable ID and a later page does,
 * the anonymous minimum-size unit is closed before the detected ID. This
 * is intentionally conservative: it is safer to surface an unknown
 * 2-page PNL for review than to silently merge it into the next student.
 */
function buildStudentRanges(detections: PageDetection[], pagesPerStudent: number): PageRange[] {
  if (detections.length === 0) return [];

  const ranges: PageRange[] = [];
  let pageStart = 1;
  let currentStudentId = detections[0]?.studentId || '';

  for (let page = 2; page <= detections.length; page++) {
    const detectedId = detections[page - 1]?.studentId || '';
    if (!detectedId) continue;

    const pagesAlreadyInRange = page - pageStart;

    if (!currentStudentId) {
      if (pagesAlreadyInRange >= pagesPerStudent) {
        ranges.push({ pageStart, pageEnd: page - 1 });
        pageStart = page;
      }
      currentStudentId = detectedId;
      continue;
    }

    if (detectedId !== currentStudentId && pagesAlreadyInRange >= pagesPerStudent) {
      ranges.push({ pageStart, pageEnd: page - 1 });
      pageStart = page;
      currentStudentId = detectedId;
    }
    // Same ID = same student, so intentionally keep collecting pages.
    // A different ID inside the minimum expected unit is retained in the
    // same range and will be surfaced below as a disagreement warning.
  }

  ranges.push({ pageStart, pageEnd: detections.length });
  return ranges;
}

/**
 * Split one merged PDF into Student-ID-aware units.
 *
 * PNLs normally span 2 pages, but translated PNLs can appear immediately
 * after the English PNL with the same Student ID. Because boundaries are
 * based on ID changes after the normal minimum unit size, 2-page and
 * 4-page PNLs can safely coexist in the same merged batch.
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

  // Detect once per page first. Those detections determine student
  // boundaries and are then reused when each output row is evaluated.
  const pageDetections: PageDetection[] = [];
  for (let page = 1; page <= totalPages; page++) {
    pageDetections.push(await detectOnPage(loaded.doc, page));
  }

  const ranges = buildStudentRanges(pageDetections, pagesPerStudent);

  // Keep the original bytes around so pdf-lib can copy pages without
  // re-fetching or re-parsing from scratch for every unit.
  const srcDocForCopy = await PDFDocument.load(bytes.slice(0));

  const rows: SplitRow[] = [];

  for (const { pageStart, pageEnd } of ranges) {
    const detections = pageDetections.slice(pageStart - 1, pageEnd);
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
      method = best.method;
      confidence = best.confidence;
    } else if (distinctIds.length > 1) {
      const best = withId.reduce((a, b) => (b.confidence > a.confidence ? b : a));
      studentId = best.studentId;
      method = best.method;
      confidence = Math.min(best.confidence, 0.4);
      warning = `Pages ${pageStart}-${pageEnd} show different Student IDs (${distinctIds.join(', ')}) -- please confirm.`;
      pagesDisagree = true;
    }

    const pageCount = pageEnd - pageStart + 1;

    if (pageCount < pagesPerStudent) {
      warning = warning
        ? `${warning} Also: only ${pageCount} page(s) remained, expected at least ${pagesPerStudent}.`
        : `Only ${pageCount} page(s) remained here, expected at least ${pagesPerStudent} -- batch page count may be off.`;
    }

    // A longer-than-normal unit is accepted automatically only when the
    // same Student ID is actually seen again later in that range. That is
    // the positive signal expected for an adjacent translated PNL. If a
    // boundary ID was simply missed, this safeguard prevents several
    // pages from being silently merged under one student's name.
    if (pageCount > pagesPerStudent && distinctIds.length === 1) {
      const matchingAnchors = withId.filter((d) => d.studentId === studentId).length;
      if (matchingAnchors < 2) {
        warning = warning
          ? `${warning} Also: ${pageCount} pages were grouped for this student, but the Student ID was detected only once.`
          : `${pageCount} pages were grouped for this student, but the Student ID was detected only once -- review for a missed student boundary.`;
      }
    }

    const outDoc = await PDFDocument.create();
    const pageIndices = [];
    for (let page = pageStart; page <= pageEnd; page++) pageIndices.push(page - 1);
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
  }

  return { rows, totalPages, pagesPerStudent, oddPageCountWarning };
}
