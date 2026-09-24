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

type Unit = {
  pageStart: number;
  pageEnd: number;
  studentId: string;
  method: DetectionMethod;
  confidence: number;
  warning?: string;
  pagesDisagree: boolean;
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
      // fall through with whatever detection already holds
    }
  }

  return detection;
}

function summarizeUnit(
  pageStart: number,
  pageEnd: number,
  detections: PageDetection[],
  expectedPages: number
): Unit {
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
  if (pageCount < expectedPages) {
    warning = warning
      ? `${warning} Also: only ${pageCount} page(s) remained, expected ${expectedPages}.`
      : `Only ${pageCount} page(s) remained here, expected ${expectedPages} -- batch page count may be off.`;
  }

  return { pageStart, pageEnd, studentId, method, confidence, warning, pagesDisagree };
}

/**
 * The exported batch is ordered as:
 *   English PNL for every student, then translated PNLs for students who need them.
 *
 * Therefore we first split the source into normal fixed-size PNL units
 * (2 pages for PNL), detect the Student ID for each unit, and only then
 * combine units with the same Student ID even when they are far apart in
 * the source PDF. This preserves English first, translation second.
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
      rows: [{
        id: crypto.randomUUID(),
        pageStart: 1,
        pageEnd: 1,
        sourcePageRanges: [{ pageStart: 1, pageEnd: 1 }],
        studentId: '',
        newFilename: '',
        method: 'none',
        confidence: 0,
        status: 'error',
        warning: msg,
      }],
      totalPages: 0,
      pagesPerStudent,
      oddPageCountWarning: false,
    };
  }

  const totalPages = loaded.numPages;
  const oddPageCountWarning = totalPages % pagesPerStudent !== 0;
  const srcDocForCopy = await PDFDocument.load(bytes.slice(0));

  // Step 1: preserve the known document structure. Each PNL is a normal
  // fixed-size unit; translations are separate units later in the batch.
  const units: Unit[] = [];
  for (let pageStart = 1; pageStart <= totalPages; pageStart += pagesPerStudent) {
    const pageEnd = Math.min(pageStart + pagesPerStudent - 1, totalPages);
    const detections: PageDetection[] = [];
    for (let page = pageStart; page <= pageEnd; page++) {
      detections.push(await detectOnPage(loaded.doc, page));
    }
    units.push(summarizeUnit(pageStart, pageEnd, detections, pagesPerStudent));
  }

  // Step 2: group only cleanly identified units by Student ID, regardless
  // of where they occur in the batch. Ambiguous/no-ID units remain
  // separate so we never merge uncertain documents into the wrong student.
  const grouped: Array<{ key: string; units: Unit[] }> = [];
  const groupIndex = new Map<string, number>();

  for (const unit of units) {
    const canGroup = !!unit.studentId && !unit.pagesDisagree && !unit.warning;
    const key = canGroup ? `student:${unit.studentId}` : `unit:${unit.pageStart}`;

    if (canGroup && groupIndex.has(key)) {
      grouped[groupIndex.get(key)!].units.push(unit);
    } else {
      groupIndex.set(key, grouped.length);
      grouped.push({ key, units: [unit] });
    }
  }

  const rows: SplitRow[] = [];

  for (const group of grouped) {
    const groupUnits = group.units;
    const first = groupUnits[0];
    const studentId = first.studentId;
    const sourcePageRanges = groupUnits.map((u) => ({ pageStart: u.pageStart, pageEnd: u.pageEnd }));

    const outDoc = await PDFDocument.create();
    const pageIndices: number[] = [];
    for (const unit of groupUnits) {
      for (let page = unit.pageStart; page <= unit.pageEnd; page++) pageIndices.push(page - 1);
    }
    const copied = await outDoc.copyPages(srcDocForCopy, pageIndices);
    copied.forEach((pg) => outDoc.addPage(pg));
    const pdfBytes = await outDoc.save();

    const warning = groupUnits.map((u) => u.warning).filter(Boolean).join(' ') || undefined;
    const pagesDisagree = groupUnits.some((u) => u.pagesDisagree);
    const confidence = Math.min(...groupUnits.map((u) => u.confidence));
    const method = groupUnits.reduce<DetectionMethod>(
      (best, u) => (u.confidence >= first.confidence ? u.method : best),
      first.method
    );

    let status: SplitRow['status'];
    if (!studentId) status = 'no-id';
    else if (warning || pagesDisagree) status = 'needs-review';
    else if (groupUnits.every((u) => u.method === 'pdf-text-label' && u.confidence >= AUTO_READY_THRESHOLD)) status = 'ready';
    else status = 'needs-review';

    rows.push({
      id: crypto.randomUUID(),
      pageStart: sourcePageRanges[0].pageStart,
      pageEnd: sourcePageRanges[sourcePageRanges.length - 1].pageEnd,
      sourcePageRanges,
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
