import { useCallback, useEffect, useRef, useState } from 'react';
import type { SplitRow } from './types';
import { splitBatchPdf } from './lib/splitPipeline';
import { makePreviewUrl } from './lib/pipeline';
import { buildFilenameForProfile, sanitizeManualId, type DocumentProfile } from './lib/profiles';
import { downloadRenamedZip, markDuplicates } from './lib/zipDownload';
import { terminateOcrWorker } from './lib/ocr';
import PdfPreviewModal from './PdfPreviewModal';

const STATUS_LABEL: Record<SplitRow['status'], string> = {
  ready: 'Ready',
  'needs-review': 'Needs review',
  'no-id': 'No ID found',
  duplicate: 'Duplicate ID',
  error: 'Error',
};

const METHOD_LABEL: Record<SplitRow['method'], string> = {
  'pdf-text-label': 'PDF text',
  positional: 'Positional',
  ocr: 'OCR',
  manual: 'Manual',
  none: '—',
};

function StatusBadge({ status }: { status: SplitRow['status'] }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABEL[status]}</span>;
}

export default function SplitView({
  profile,
  onHasRowsChange,
}: {
  profile: DocumentProfile;
  onHasRowsChange?: (hasRows: boolean) => void;
}) {
  const [rows, setRows] = useState<SplitRow[]>([]);

  useEffect(() => {
    onHasRowsChange?.(rows.length > 0);
  }, [rows.length, onHasRowsChange]);
  const [processing, setProcessing] = useState(false);
  const [sourceName, setSourceName] = useState('');
  const [oddPageWarning, setOddPageWarning] = useState(false);
  const [totalPages, setTotalPages] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ url: string; filename: string } | null>(null);

  const openPreview = useCallback((row: SplitRow) => {
    if (!row.pdfBytes) return;
    const url = makePreviewUrl(row.pdfBytes);
    setPreview({ url, filename: row.newFilename || `Pages ${row.pageStart}-${row.pageEnd}` });
  }, []);

  const closePreview = useCallback(() => {
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview(null);
  }, [preview]);

  const confirmRow = useCallback((rowId: string) => {
    setRows((prev) =>
      markDuplicates(
        prev.map((r) => {
          if (r.id !== rowId) return r;
          // A page-disagreement warning means the two pages in this unit
          // may belong to different students -- confirming the ID text
          // doesn't verify the actual page content, so it can't be the
          // thing that clears this warning. The row stays blocked until
          // the source is corrected and re-split; the person can still
          // open and inspect the PDF, just not export it from here.
          if (r.pagesDisagree) return r;
          return { ...r, status: 'ready' as const, confirmed: true, warning: undefined };
        })
      )
    );
  }, []);

  const runSplit = useCallback(
    async (file: File) => {
      setProcessing(true);
      setSourceName(file.name);
      setRows([]);
      setLoadError(null);
      try {
        const result = await splitBatchPdf(file, profile);
        setRows(markDuplicates(result.rows));
        setTotalPages(result.totalPages);
        setOddPageWarning(result.oddPageCountWarning);
      } catch (e: any) {
        // Anything that throws past this point -- a page-copy failure in
        // pdf-lib, an out-of-memory error, a corrupt structure loadPdf's
        // own try/catch didn't anticipate -- used to become an unhandled
        // rejection here, leaving the UI sitting on the empty rows array
        // set above with no explanation. Surfacing whatever message is
        // available (or a generic fallback) is better than a silent,
        // confusing dead end, even though this can't enumerate every
        // possible pdf-lib/pdf.js failure mode individually.
        setLoadError(e?.message || 'Something went wrong while processing this file. Try a different file, or clear and try again.');
        setSourceName('');
      } finally {
        setProcessing(false);
      }
    },
    [profile]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragActive(false);
      const f = e.dataTransfer.files?.[0];
      if (f) runSplit(f);
    },
    [runSplit]
  );

  const onEditId = useCallback((rowId: string, newId: string) => {
    setRows((prev) => {
      const next = prev.map((r) => {
        if (r.id !== rowId) return r;
        const cleanId = sanitizeManualId(newId);
        // Editing the ID text updates the filename, but must not silently
        // clear a page-disagreement warning -- retyping a number doesn't
        // change what's actually printed on the two pages. Such rows stay
        // in review (never auto-"ready") regardless of what's typed here.
        const stillDisagrees = !!r.pagesDisagree;
        return {
          ...r,
          studentId: cleanId,
          newFilename: cleanId ? buildFilenameForProfile(profile, cleanId) : '',
          method: 'manual' as const,
          confidence: cleanId ? 1 : 0,
          status: stillDisagrees ? ('needs-review' as const) : cleanId ? ('ready' as const) : ('no-id' as const),
          warning: stillDisagrees ? r.warning : undefined,
          editedManually: true,
        };
      });
      return markDuplicates(next);
    });
  }, [profile]);

  const clearAll = useCallback(() => {
    setRows([]);
    setSourceName('');
    setTotalPages(0);
    setOddPageWarning(false);
    setLoadError(null);
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
    await downloadRenamedZip(readyRows, `${profile.shortLabel.replace(/\s+/g, '_')}_Split_Batch.zip`);
  }, [rows, profile]);

  return (
    <div className="view">
      {rows.length === 0 && (
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
            hidden
            onChange={(e) => e.target.files?.[0] && runSplit(e.target.files[0])}
          />
          <p className="dropzone-title">Drop one merged {profile.shortLabel} batch PDF here</p>
          <p className="dropzone-sub">or</p>
          <button
            className="btn btn-primary"
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              fileInputRef.current?.click();
            }}
          >
            Choose PDF
          </button>
        </div>
      )}

      {processing && <div className="progress">Splitting and detecting IDs across {sourceName}…</div>}

      {rows.length > 0 && (
        <>
          <div className="toolbar">
            <span className="source-note">
              {sourceName} — {totalPages} pages, grouped into {rows.length} student unit{rows.length === 1 ? '' : 's'}
            </span>
          </div>
          {oddPageWarning && (
            <div className="toolbar-note toolbar-note-block">
              ⚠ Total page count ({totalPages}) isn't evenly divisible by the normal {profile.pagesPerStudent}-page unit.
              Review any flagged unit before downloading.
            </div>
          )}

          <div className="toolbar">
            <button className="btn btn-secondary" onClick={clearAll}>
              Clear / Upload Different PDF
            </button>
            <button className="btn btn-primary" onClick={handleDownload} disabled={readyCount === 0}>
              Download Split Files ({readyCount})
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
                <th>Pages</th>
                <th>Student ID</th>
                <th>New Filename</th>
                <th>Method</th>
                <th>Status</th>
                <th></th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className={row.status === 'error' ? 'row-error' : ''}>
                  <td className="cell-filename">
                    {(row.sourcePageRanges ?? [{ pageStart: row.pageStart, pageEnd: row.pageEnd }])
                      .map((range) =>
                        range.pageStart === range.pageEnd
                          ? `Page ${range.pageStart}`
                          : `Pages ${range.pageStart}–${range.pageEnd}`
                      )
                      .join(', ')}
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
                    {row.warning && <div className="error-msg">{row.warning}</div>}
                    {row.pagesDisagree && (
                      <div className="error-msg">Editing the ID won't clear this -- re-split from a corrected source.</div>
                    )}
                  </td>
                  <td>
                    {row.status === 'needs-review' && row.studentId && !row.pagesDisagree && (
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
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {loadError && rows.length === 0 && !processing && (
        <div className="toolbar-note-block" style={{ marginTop: 12 }}>
          ⚠ {loadError}
        </div>
      )}

      {rows.length === 0 && !processing && (
        <p className="empty-hint">
          Upload one merged PDF containing multiple students' letters. The tool splits the batch into normal document
          units, detects each Student ID, and combines matching IDs into one student PDF — including translated PNLs that
          appear later in the batch after the English PNLs.
        </p>
      )}

      {preview && <PdfPreviewModal url={preview.url} filename={preview.filename} onClose={closePreview} />}
    </div>
  );
}
