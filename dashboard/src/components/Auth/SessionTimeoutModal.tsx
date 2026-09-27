import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, RefreshCcw } from 'lucide-react';
import { Modal } from '../Modal';

const JWT_WARNING_SECONDS = 120;

export const SessionTimeoutModal: React.FC = () => {
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [extending, setExtending] = useState(false);

  const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:3002';

  const getAuthToken = () => localStorage.getItem('authToken');

  const decodeExp = (token: string): number | null => {
    try {
      const payload = token.split('.')[1];
      const decoded = JSON.parse(atob(payload));
      if (decoded && typeof decoded.exp === 'number') {
        return decoded.exp;
      }
    } catch {
      // ignore malformed token
    }
    return null;
  };

  useEffect(() => {
    const interval = setInterval(() => {
      const token = getAuthToken();
      if (!token) {
        setTimeLeft(null);
        return;
      }

      const exp = decodeExp(token);
      if (!exp) {
        setTimeLeft(null);
        return;
      }

      const remaining = Math.max(0, Math.floor(exp - Date.now() / 1000));
      setTimeLeft(remaining);
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const displayTime = useMemo(() => {
    if (timeLeft === null) return '00:00';
    const minutes = Math.floor(timeLeft / 60);
    const seconds = timeLeft % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }, [timeLeft]);

  const isOpen = timeLeft !== null && timeLeft > 0 && timeLeft <= JWT_WARNING_SECONDS;

  const handleExtend = async () => {
    const token = getAuthToken();
    if (!token) return;

    setExtending(true);

    try {
      const response = await fetch(`${apiBaseUrl}/auth/refresh`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error('Failed to refresh session');
      }

      const data = await response.json();
      if (data.token) {
        localStorage.setItem('authToken', data.token);
        setTimeLeft(null);
      }
    } catch (err) {
      console.error('Session extension failed:', err);
    } finally {
      setExtending(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      title="Session Expiring Soon"
      description={`Your session will expire in ${displayTime}. Extend your session to avoid being logged out.`}
      onClose={() => {}}
      closeOnBackdropClick={false}
      hideTitle={false}
      size="sm"
      icon={
        <div className="shrink-0 rounded-full bg-amber-500/10 p-3 text-amber-500">
          <AlertTriangle size={24} aria-hidden="true" />
        </div>
      }
      footer={
        <button
          type="button"
          onClick={handleExtend}
          disabled={extending}
          className="action-button inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2 text-sm font-medium text-white hover:bg-primary/80 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-text"
        >
          <RefreshCcw size={16} aria-hidden="true" />
          {extending ? 'Extending…' : 'Extend Session'}
        </button>
      }
    >
      <div className="space-y-3 text-sm text-slate-300">
        <p>You will be logged out automatically when the timer reaches zero.</p>
        <p className="text-xs text-slate-400">
          If you do not extend your session, you will need to sign in again using your wallet.
        </p>
      </div>
    </Modal>
  );
};

export default SessionTimeoutModal;
