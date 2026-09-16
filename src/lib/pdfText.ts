import * as pdfjsLib from 'pdfjs-dist';
import type { TextItem } from '../types';

// Point pdf.js at the locally bundled worker + assets. No CDN, ever.
//
// These are built from import.meta.env.BASE_URL rather than a hardcoded
// leading-slash path -- a plain '/pdfjs/...' is always resolved from the
// domain root, which only happens to work when the app is hosted at the
// root of a domain. Hosted under a subpath instead (e.g. an MCPS server at
// https://host/tools/pnl/, which is the planned eventual home for this
// app), '/pdfjs/...' would request https://host/pdfjs/... -- the wrong,
// nonexistent location -- while the rest of the app correctly loads from
// /tools/pnl/. BASE_URL is set at build time from vite.config.ts's `base`
// option and already ends in a trailing slash.
const ASSET_BASE = import.meta.env.BASE_URL;
pdfjsLib.GlobalWorkerOptions.workerSrc = `${ASSET_BASE}pdfjs/pdf.worker.min.mjs`;

const CMAP_URL = `${ASSET_BASE}pdfjs/cmaps/`;
const STANDARD_FONT_DATA_URL = `${ASSET_BASE}pdfjs/standard_fonts/`;

export interface PageTextResult {
  items: TextItem[];
  pageWidth: number;
  pageHeight: number;
}

export interface LoadedPdf {
  doc: pdfjsLib.PDFDocumentProxy;
  numPages: number;
}

export class PasswordProtectedError extends Error {
  constructor() {
    super('PDF is password protected');
    this.name = 'PasswordProtectedError';
  }
}

export class CorruptPdfError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'CorruptPdfError';
  }
}

/** Load a PDF from raw bytes. Never touches the network. */
export async function loadPdf(bytes: ArrayBuffer): Promise<LoadedPdf> {
  const loadingTask = pdfjsLib.getDocument({
    data: bytes,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    isEvalSupported: false,
  });
  try {
    const doc = await loadingTask.promise;
    return { doc, numPages: doc.numPages };
  } catch (err: any) {
    if (err?.name === 'PasswordException') {
      throw new PasswordProtectedError();
    }
    throw new CorruptPdfError(err?.message ?? 'Unable to parse PDF');
  }
}

/**
 * Extract text items from a page with viewport (top-down, origin top-left)
 * coordinates, matching the convention used throughout the detection logic.
 */
export async function extractPageText(
  doc: pdfjsLib.PDFDocumentProxy,
  pageNumber: number
): Promise<PageTextResult> {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const textContent = await page.getTextContent();

  const items: TextItem[] = [];
  for (const raw of textContent.items as any[]) {
    if (typeof raw.str !== 'string' || raw.str.trim() === '') continue;
    // Combine the item's text-space transform with the viewport transform
    // to get coordinates in the same top-down space we use everywhere else.
    const tx = pdfjsLib.Util.transform(viewport.transform, raw.transform);
    const fontHeight = Math.hypot(tx[2], tx[3]);
    const x0 = tx[4];
    // raw.width is already expressed in the same (device/viewport) units as
    // tx[4]/tx[5] once combined with the viewport's own scale -- it must
    // NOT be multiplied again by the text-matrix scale, or it balloons by
    // ~fontSize-fold (this was a real bug, caught by testing against a real
    // sample PDF: a 6-char digit run was silently truncated because the
    // inflated width pushed the column-boundary math out of alignment).
    const width = (raw.width ?? 0) * viewport.scale;
    const baselineY = tx[5];
    const top = baselineY - fontHeight;
    const bottom = baselineY;

    items.push({
      str: raw.str,
      x0,
      x1: x0 + width,
      top,
      bottom,
    });
  }

  return { items, pageWidth: viewport.width, pageHeight: viewport.height };
}

/** Render a page to a canvas at the given scale, for OCR fallback. */
export async function renderPageToCanvas(
  doc: pdfjsLib.PDFDocumentProxy,
  pageNumber: number,
  scale = 2.5
): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d')!;
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}
