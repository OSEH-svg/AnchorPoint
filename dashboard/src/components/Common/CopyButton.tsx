import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';

interface CopyButtonProps {
  value: string;
  label: string;
  className?: string;
}

const COPY_RESET_MS = 2000;

export const CopyButton = ({ value, label, className = '' }: CopyButtonProps) => {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (copyState === 'idle') return undefined;

    const timeoutId = window.setTimeout(() => setCopyState('idle'), COPY_RESET_MS);
    return () => window.clearTimeout(timeoutId);
  }, [copyState]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  return (
    <span className="relative inline-flex items-center">
      <button
        type="button"
        onClick={handleCopy}
        aria-label={`Copy ${label.toLowerCase()}`}
        className={`shrink-0 rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${className}`}
      >
        {copyState === 'copied' ? (
          <Check size={14} className="text-emerald-400" aria-hidden="true" />
        ) : (
          <Copy size={14} aria-hidden="true" />
        )}
      </button>
      {copyState === 'copied' && (
        <span
          role="status"
          className="absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-[10px] font-medium text-emerald-400 shadow-lg"
        >
          Copied!
        </span>
      )}
      <span className="sr-only" aria-live="polite">
        {copyState === 'copied' ? `${label} copied to clipboard.` : ''}
        {copyState === 'failed' ? `Unable to copy ${label.toLowerCase()}.` : ''}
      </span>
    </span>
  );
};

export default CopyButton;
