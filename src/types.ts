export type DetectionMethod = 'pdf-text-label' | 'positional' | 'ocr' | 'manual' | 'none';

export type FileStatus = 'ready' | 'needs-review' | 'no-id' | 'duplicate' | 'error';

export interface FileRow {
  id: string; // internal row id (uuid)
  file: File;
  originalName: string;
  studentId: string; // '' if none found
  newFilename: string;
  method: DetectionMethod;
  status: FileStatus;
  confidence: number; // 0-1
  errorMessage?: string;
  pdfBytes?: ArrayBuffer; // cached original bytes for zipping
  editedManually?: boolean;
  confirmed?: boolean; // user explicitly reviewed and approved this ID
}

export interface TextItem {
  str: string;
  x0: number;
  x1: number;
  top: number;
  bottom: number;
}

/** One 2-page (or n-page) student unit extracted from a merged batch PDF. */
export interface SplitRow {
  id: string;
  pageStart: number; // 1-indexed, inclusive
  pageEnd: number; // 1-indexed, inclusive
  studentId: string;
  newFilename: string;
  method: DetectionMethod;
  confidence: number;
  status: FileStatus;
  warning?: string; // e.g. "IDs differ between the two pages"
  pagesDisagree?: boolean; // true only for the "these pages may belong to different students" case -- see SplitView
  pdfBytes?: ArrayBuffer; // the split-out pages, ready to zip
  editedManually?: boolean;
  confirmed?: boolean; // user explicitly reviewed and approved this ID
}
