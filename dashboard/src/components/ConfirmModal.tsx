import React, { useState, useEffect, useId } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal } from './Modal';

interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
  requireTypingConfirm?: boolean;
  isDanger?: boolean;
}

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  isOpen,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  onConfirm,
  onCancel,
  requireTypingConfirm = false,
  isDanger = true,
}) => {
  const [typedConfirm, setTypedConfirm] = useState('');
  const inputId = useId();

  useEffect(() => {
    if (isOpen) {
      setTypedConfirm('');
    }
  }, [isOpen]);

  const confirmBlocked = requireTypingConfirm && typedConfirm.toUpperCase() !== 'CONFIRM';

  const handleConfirm = () => {
    if (confirmBlocked) {
      return;
    }
    onConfirm();
  };

  return (
    <Modal
      isOpen={isOpen}
      title={title}
      description={message}
      onClose={onCancel}
      icon={
        <div
          className={`shrink-0 rounded-full p-3 ${
            isDanger ? 'bg-rose-500/10 text-rose-500' : 'bg-amber-500/10 text-amber-500'
          }`}
        >
          <AlertTriangle size={24} aria-hidden="true" />
        </div>
      }
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            className="action-button rounded-lg border border-slate-700 bg-slate-800/50 px-4 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-text"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={confirmBlocked}
            className={`action-button rounded-lg px-5 py-2 text-sm font-medium text-white disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-text ${
              isDanger
                ? 'bg-rose-600 shadow-lg shadow-rose-600/20 hover:bg-rose-500'
                : 'bg-amber-600 shadow-lg shadow-amber-600/20 hover:bg-amber-500'
            }`}
          >
            {confirmText}
          </button>
        </>
      }
    >
      {requireTypingConfirm && (
        <div className="space-y-2">
          <label
            htmlFor={inputId}
            className="block text-xs font-semibold uppercase tracking-wider text-slate-500"
          >
            Type <span className="text-rose-400">CONFIRM</span> to proceed:
          </label>
          <input
            id={inputId}
            type="text"
            value={typedConfirm}
            onChange={(e) => setTypedConfirm(e.target.value)}
            placeholder="CONFIRM"
            className="input-field w-full font-mono text-sm tracking-widest placeholder-slate-700"
            autoComplete="off"
          />
        </div>
      )}
    </Modal>
  );
};

export default ConfirmModal;
