import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileRow } from './types';
import { processFile, makePreviewUrl } from './lib/pipeline';
import { buildFilenameForProfile, sanitizeManualId, type DocumentProfile } from './lib/profiles';
import { downloadRenamedZip, markDuplicates } from './lib/zipDownload';
import { terminateOcrWorker } from './lib/ocr';
import PdfPreviewModal from './PdfPreviewModal';

const STATUS_LABEL: Record<FileRow['status'], string> = {
  ready: 'Ready',
  'needs-review': 'Needs review',
  'no-id': 'No ID found',
  duplicate: 'Duplicate ID',
  error: 'Error',
};

const METHOD_LABEL: Record<FileRow['method'], string> = {
  'pdf-text-label': 'PDF text',
  positional: 'Positional',
  ocr: 'OCR',
  manual: 'Manual',
  none: '—',
};

function StatusBadge({ status }: { status: FileRow['status'] }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABEL[status]}</span>;
}

export default function RenameView({
  profile,
  onHasRowsChange,
}: {
  profile: DocumentProfile;
  onHasRowsChange?: (hasRows: boolean) => void;
}) {
  const [rows, setRows] = useState<FileRow[]>([]);

  useEffect(() => {
    onHasRowsChange?.(rows.length > 0);
  }, [rows.length, onHasRowsChange]);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [preview, setPreview] = useState<{ url: string; filename: string } | null>(null);

  const openPreview = useCallback((row: FileRow) => {
    if (!row.pdfBytes) return;
    const url = makePreviewUrl(row.pdfBytes);
    setPreview({ url, filename: row.newFilename || row.originalName });
  }, []);

  const closePreview = useCallback(() => {
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview(null);
  }, [preview]);

  const addFiles = useCallback(async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (files.length === 0) return;

    // Placeholder rows so the table populates immediately and the UI never
    // looks frozen while processing runs.
    const placeholders: FileRow[] = files.map((f) => ({
      id: crypto.randomUUID(),
      file: f,
      originalName: f.name,
      studentId: '',
      newFilename: '',
      method: 'none',
      status: 'no-id',
      confidence: 0,
    }));
    setRows((prev) => [...prev, ...placeholders]);
    setProcessing(true);
    setProgress({ done: 0, total: files.length });

    // Process with a small concurrency cap so we use multiple cores (OCR in
    // particular benefits) without spawning hundreds of workers at once.
    const CONCURRENCY = 3;
    let idx = 0;
    let done = 0;

    async function worker() {
      while (idx < files.length) {
        const i = idx++;
        const file = files[i];
        const placeholderId = placeholders[i].id;
        try {
          const result = await processFile(file, profile);
          setRows((prev) => {
            const next = prev.map((r) => (r.id === placeholderId ? { ...result, id: placeholderId } : r));
            return markDuplicates(next);
          });
        } catch (e: any) {
          setRows((prev) =>
            prev.map((r) =>
              r.id === placeholderId
                ? { ...r, status: 'error' as const, errorMessage: e?.message ?? 'Unexpected error' }
                : r
            )
          );
        }
        done++;
        setProgress({ done, total: files.length });
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
    setProcessing(false);
    setProgress(null);
  }, [profile]);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragActive(false);
      if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
    },
    [addFiles]
  );

  const onEditId = useCallback((rowId: string, newId: string) => {
    setRows((prev) => {
      const next = prev.map((r) => {
        if (r.id !== rowId) return r;
        const cleanId = sanitizeManualId(newId);
        return {
          ...r,
          studentId: cleanId,
          newFilename: cleanId ? buildFilenameForProfile(profile, cleanId) : '',
          method: 'manual' as const,
          confidence: cleanId ? 1 : 0,
          status: cleanId ? ('ready' as const) : ('no-id' as const),
          editedManually: true,
        };
      });
      return markDuplicates(next);
    });
  }, [profile]);

  const removeRow = useCallback((rowId: string) => {
    setRows((prev) => markDuplicates(prev.filter((r) => r.id !== rowId)));
  }, []);

  const confirmRow = useCallback((rowId: string) => {
    setRows((prev) =>
      markDuplicates(prev.map((r) => (r.id === rowId ? { ...r, status: 'ready' as const, confirmed: true } : r)))
    );
  }, []);

  const clearAll = useCallback(() => {
    setRows([]);
    terminateOcrWorker();
  }, []);

  const readyCount = rows.filter((r) => r.status === 'ready').length;
  const excludedCount = rows.length - readyCount;
  const excludedBreakdown = {
    review: rows.filter((r) => r.status === 'needs-review').length,
    duplicate: rows.filter((r) => r.status === 'duplicate').length,
    noId: rows.filter((r) => r.status === 'no-id').length,
    error: rows.filter((r) => r.status === 'error').length,
  };

  const handleDownload = useCallback(async () => {
    const readyRows = rows.filter((r) => r.status === 'ready');
    if (readyRows.length === 0) return;
    await downloadRenamedZip(readyRows, `${profile.shortLabel.replace(/\s+/g, '_')}_Renamed_Batch.zip`);
  }, [rows, profile]);

  return (
    <div className="view">
      <div
        className={`dropzone ${dragActive ? 'active' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          hidden
          onChange={(e) => e.target.files && addFiles(e.target.files)}
        />
        <p className="dropzone-title">Drop {profile.shortLabel} PDFs here</p>
        <p className="dropzone-sub">or</p>
        <button
          className="btn btn-primary"
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            fileInputRef.current?.click();
          }}
        >
          Choose PDFs
        </button>
      </div>

      {progress && (
        <div className="progress">
          Processing {progress.done} of {progress.total}
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div className="toolbar">
            <button className="btn" onClick={() => fileInputRef.current?.click()}>
              Add More PDFs
            </button>
            <button className="btn btn-secondary" onClick={clearAll}>
              Clear All
            </button>
            <button className="btn btn-primary" onClick={handleDownload} disabled={readyCount === 0}>
              Download Renamed Files ({readyCount})
            </button>
            {excludedCount > 0 && (
              <span className="toolbar-note">
                {excludedCount} of {rows.length} excluded:{' '}
                {[
                  excludedBreakdown.review > 0 && `${excludedBreakdown.review} needs review`,
                  excludedBreakdown.duplicate > 0 && `${excludedBreakdown.duplicate} duplicate`,
                  excludedBreakdown.noId > 0 && `${excludedBreakdown.noId} no ID found`,
                  excludedBreakdown.error > 0 && `${excludedBreakdown.error} error${excludedBreakdown.error === 1 ? '' : 's'}`,
                ]
                  .filter(Boolean)
                  .join(', ')}
              </span>
            )}
          </div>

          <table className="file-table">
            <thead>
              <tr>
                <th>Original File</th>
                <th>Student ID</th>
                <th>New Filename</th>
                <th>Method</th>
                <th>Status</th>
                <th></th>
                <th></th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className={row.status === 'error' ? 'row-error' : ''}>
                  <td className="cell-filename" title={row.originalName}>
                    {row.originalName}
                  </td>
                  <td>
                    <input
                      className="id-input"
                      type="text"
                      value={row.studentId}
                      placeholder={row.status === 'error' ? '—' : 'e.g. 349817'}
                      disabled={row.status === 'error'}
                      onChange={(e) => onEditId(row.id, e.target.value)}
                    />
                  </td>
                  <td className="cell-newname">{row.newFilename || '—'}</td>
                  <td>{METHOD_LABEL[row.method]}</td>
                  <td>
                    <StatusBadge status={row.status} />
                    {row.errorMessage && <div className="error-msg">{row.errorMessage}</div>}
                  </td>
                  <td>
                    {row.status === 'needs-review' && row.studentId && (
                      <button className="btn-confirm" onClick={() => confirmRow(row.id)} title="Confirm this ID is correct">
                        Confirm
                      </button>
                    )}
                  </td>
                  <td>
                    {row.pdfBytes && row.status !== 'error' && (
                      <button className="btn-open" onClick={() => openPreview(row)} title="Open PDF to review">
                        Open
                      </button>
                    )}
                  </td>
                  <td>
                    <button className="btn-remove" onClick={() => removeRow(row.id)} title="Remove from batch">
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {rows.length === 0 && !processing && (
        <p className="empty-hint">No files yet. Drag in a batch of {profile.shortLabel} PDFs to get started.</p>
      )}

      {preview && <PdfPreviewModal url={preview.url} filename={preview.filename} onClose={closePreview} />}
    </div>
  );
}
