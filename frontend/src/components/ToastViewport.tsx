import { useToast } from '../context/ToastContext';

export function ToastViewport() {
  const { toasts, removeToast } = useToast();

  return (
    <div className="toast-viewport">
      {toasts.map((toast) => (
        <div className={`toast toast-${toast.tone}`} key={toast.id}>
          <div className="toast-copy">
            <strong>{toast.title}</strong>
            {toast.description ? <p>{toast.description}</p> : null}
          </div>
          <button onClick={() => removeToast(toast.id)} className="toast-close" aria-label="Close notification">
            x
          </button>
        </div>
      ))}
    </div>
  );
}
