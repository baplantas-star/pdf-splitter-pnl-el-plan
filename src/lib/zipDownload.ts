import JSZip from 'jszip';
import type { FileStatus, DetectionMethod } from '../types';

interface Downloadable {
  pdfBytes?: ArrayBuffer;
  newFilename: string;
}

interface Dedupable {
  studentId: string;
  status: FileStatus;
  method: DetectionMethod;
  confidence: number;
  confirmed?: boolean;
}

/**
 * Build and trigger download of a ZIP containing the renamed PDFs.
 * Only rows with status 'ready' should be passed in; callers filter before
 * calling this.
 */
export async function downloadRenamedZip<T extends Downloadable>(rows: T[], zipFilename = 'PNL_Renamed_Batch.zip') {
  const zip = new JSZip();
  const usedNames = new Set<string>();

  for (const row of rows) {
    if (!row.pdfBytes || !row.newFilename) continue;
    let name = row.newFilename;
    // Belt-and-suspenders: even if duplicate resolution was supposed to
    // happen upstream, never let two files silently collide in the zip.
    if (usedNames.has(name)) {
      const base = name.replace(/\.pdf$/i, '');
      let n = 2;
      while (usedNames.has(`${base} (${n}).pdf`)) n++;
      name = `${base} (${n}).pdf`;
    }
    usedNames.add(name);
    zip.file(name, row.pdfBytes);
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = zipFilename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Recompute duplicate flags across the whole batch based on current Student IDs. */
export function markDuplicates<T extends Dedupable>(rows: T[]): T[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!r.studentId) continue;
    counts.set(r.studentId, (counts.get(r.studentId) ?? 0) + 1);
  }
  return rows.map((r) => {
    if (r.status === 'error') return r;
    if (r.studentId && (counts.get(r.studentId) ?? 0) > 1) {
      return { ...r, status: 'duplicate' as const };
    }
    // if it was previously flagged duplicate but no longer collides, restore
    // a sensible status based on its detection confidence/method
    if (r.status === 'duplicate') {
      const restored: FileStatus = !r.studentId
        ? 'no-id'
        : r.confirmed || (r.method === 'pdf-text-label' && r.confidence >= 0.85)
        ? 'ready'
        : 'needs-review';
      return { ...r, status: restored };
    }
    return r;
  });
}
