'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

type EventType = 'connected' | 'heartbeat' | 'scrape_started' | 'scrape_progress' | 'scrape_completed' | 'provider_updated' | 'error';

interface SSEEvent {
  type: EventType;
  data?: Record<string, unknown>;
  timestamp: string;
}

interface UseRealTimeUpdatesOptions {
  onScrapeStarted?: (data: Record<string, unknown>) => void;
  onScrapeProgress?: (data: Record<string, unknown>) => void;
  onScrapeCompleted?: (data: Record<string, unknown>) => void;
  onProviderUpdated?: (data: Record<string, unknown>) => void;
  onError?: (data: Record<string, unknown>) => void;
  autoReconnect?: boolean;
  reconnectDelay?: number;
}

export function useRealTimeUpdates(options: UseRealTimeUpdatesOptions = {}) {
  const {
    onScrapeStarted,
    onScrapeProgress,
    onScrapeCompleted,
    onProviderUpdated,
    onError,
    autoReconnect = true,
    reconnectDelay = 5000,
  } = options;

  const [isConnected, setIsConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<SSEEvent | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const connect = useCallback(() => {
    if (eventSourceRef.current?.readyState === EventSource.OPEN) {
      return;
    }

    try {
      const eventSource = new EventSource('/api/events');
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        setIsConnected(true);
        setConnectionError(null);
        console.log('[SSE] Connected to event stream');
      };

      eventSource.onmessage = (event) => {
        try {
          const data: SSEEvent = JSON.parse(event.data);
          setLastEvent(data);

          switch (data.type) {
            case 'scrape_started':
              onScrapeStarted?.(data.data || {});
              break;
            case 'scrape_progress':
              onScrapeProgress?.(data.data || {});
              break;
            case 'scrape_completed':
              onScrapeCompleted?.(data.data || {});
              break;
            case 'provider_updated':
              onProviderUpdated?.(data.data || {});
              break;
            case 'error':
              onError?.(data.data || {});
              break;
            case 'connected':
              console.log('[SSE] Connection confirmed');
              break;
            case 'heartbeat':
              // Heartbeat received, connection is alive
              break;
          }
        } catch (err) {
          console.error('[SSE] Failed to parse event:', err);
        }
      };

      eventSource.onerror = () => {
        setIsConnected(false);
        eventSource.close();
        eventSourceRef.current = null;

        if (autoReconnect) {
          setConnectionError('Connection lost. Reconnecting...');
          reconnectTimeoutRef.current = setTimeout(() => {
            console.log('[SSE] Attempting to reconnect...');
            connect();
          }, reconnectDelay);
        } else {
          setConnectionError('Connection lost');
        }
      };
    } catch (err) {
      setConnectionError('Failed to connect');
      console.error('[SSE] Connection error:', err);
    }
  }, [autoReconnect, reconnectDelay, onScrapeStarted, onScrapeProgress, onScrapeCompleted, onProviderUpdated, onError]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setIsConnected(false);
  }, []);

  useEffect(() => {
    connect();

    return () => {
      disconnect();
    };
  }, [connect, disconnect]);

  return {
    isConnected,
    lastEvent,
    connectionError,
    connect,
    disconnect,
  };
}

export default useRealTimeUpdates;
