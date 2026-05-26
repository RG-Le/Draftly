interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}

export function Dialog({ open, title, onClose, children }: DialogProps) {
  if (!open) return null;

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog-box" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h3>{title}</h3>
          <button className="dialog-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>
        <div className="dialog-body">{children}</div>
      </div>
    </div>
  );
}
