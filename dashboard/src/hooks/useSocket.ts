import { useEffect, useMemo, useState } from 'react';
import { io, Socket } from 'socket.io-client';

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected';
export type TransactionUpdatePayload = {
  id: string;
  status?: string;
  ledger?: number;
  [key: string]: unknown;
};

type UseSocketOptions = {
  apiBaseUrl: string;
  onStatusChange?: (status: ConnectionStatus) => void;
  onTransactionUpdate?: (payload: TransactionUpdatePayload) => void;
};

const computeSocketUrl = (apiBaseUrl: string) => {
  try {
    const parsed = new URL(apiBaseUrl);
    return `${parsed.protocol === 'https:' ? 'wss' : 'ws'}://${parsed.host}`;
  } catch {
    return apiBaseUrl;
  }
};

export const useSocket = ({ apiBaseUrl, onStatusChange, onTransactionUpdate }: UseSocketOptions) => {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting');

  const socketUrl = useMemo(() => computeSocketUrl(apiBaseUrl), [apiBaseUrl]);

  useEffect(() => {
    if (!apiBaseUrl) {
      setConnectionStatus('disconnected');
      onStatusChange?.('disconnected');
      return undefined;
    }

    setConnectionStatus('connecting');
    onStatusChange?.('connecting');

    const socket: Socket = io(socketUrl, {
      autoConnect: true,
      transports: ['websocket'],
      path: '/socket.io',
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
    });

    socket.on('connect', () => {
      setConnectionStatus('connected');
      onStatusChange?.('connected');
    });

    socket.on('disconnect', () => {
      setConnectionStatus('disconnected');
      onStatusChange?.('disconnected');
    });

    socket.on('connect_error', () => {
      setConnectionStatus('disconnected');
      onStatusChange?.('disconnected');
    });

    socket.on('tx_updated', (payload: TransactionUpdatePayload) => {
      onTransactionUpdate?.(payload);
    });

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('connect_error');
      socket.off('tx_updated');
      socket.disconnect();
    };
  }, [socketUrl, apiBaseUrl, onStatusChange, onTransactionUpdate]);

  return {
    connectionStatus,
  };
};
