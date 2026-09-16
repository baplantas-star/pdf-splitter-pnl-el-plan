import { createWorker } from 'tesseract.js';
import { detectStudentId } from './detectId';
import type { TextItem } from '../types';

let workerPromise: ReturnType<typeof createWorker> | null = null;

// Same reasoning as pdfText.ts: build from BASE_URL rather than a
// hardcoded leading-slash path, so this still resolves correctly once
// hosted under an MCPS subpath instead of a domain root.
const ASSET_BASE = import.meta.env.BASE_URL;

/** Lazily create a single reusable Tesseract worker, using only local assets. */
function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker('eng', 1, {
      workerPath: `${ASSET_BASE}tesseract/worker.min.js`,
      corePath: `${ASSET_BASE}tesseract/tesseract-core-simd-lstm.wasm.js`,
      langPath: `${ASSET_BASE}tesseract`,
      gzip: true,
      // No logger/progress callbacks phone home -- tesseract.js's logger is
      // purely local (in-memory callback), not a network call.
    });
  }
  return workerPromise;
}

export interface OcrResult {
  studentId: string;
  confidence: number;
  rawText: string;
}

/**
 * Run OCR on a canvas region and attempt to recover a Student ID using the
 * same label-matching heuristics as the embedded-text path, by converting
 * Tesseract's word-level bounding boxes into the same TextItem shape.
 *
 * OCR doesn't need per-language trained data here -- digits are digits
 * regardless of the surrounding script, so the single bundled English
 * model reads them fine even against non-English scanned pages.
 */
export async function ocrStudentId(canvas: HTMLCanvasElement): Promise<OcrResult> {
  const worker = await getWorker();
  const { data } = await worker.recognize(canvas, {}, { blocks: true });

  const items: TextItem[] = [];
  const words: any[] = (data as any).blocks
    ? (data as any).blocks.flatMap((b: any) =>
        b.paragraphs.flatMap((p: any) => p.lines.flatMap((l: any) => l.words))
      )
    : (data as any).words ?? [];

  for (const w of words) {
    if (!w.text || !w.text.trim()) continue;
    const bbox = w.bbox;
    items.push({ str: w.text, x0: bbox.x0, x1: bbox.x1, top: bbox.y0, bottom: bbox.y1 });
  }

  const result = detectStudentId(items, canvas.width);
  return {
    studentId: result.studentId,
    confidence: result.studentId ? Math.min(result.confidence, 0.75) : 0, // OCR caps below auto-ready
    rawText: data.text ?? '',
  };
}

export async function terminateOcrWorker() {
  if (workerPromise) {
    const worker = await workerPromise;
    await worker.terminate();
    workerPromise = null;
  }
}
