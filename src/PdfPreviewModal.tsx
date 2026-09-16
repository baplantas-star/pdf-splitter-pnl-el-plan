import { useEffect } from 'react';

interface Props {
  url: string;
  filename: string;
  onClose: () => void;
}

export default function PdfPreviewModal({ url, filename, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">{filename || 'Preview'}</span>
          <button className="modal-close" onClick={onClose} title="Close preview">
            ✕
          </button>
        </div>
        <iframe title={filename || 'PDF preview'} src={url} className="modal-iframe" />
      </div>
    </div>
  );
}
