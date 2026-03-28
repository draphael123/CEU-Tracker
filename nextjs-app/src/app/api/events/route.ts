// Server-Sent Events for real-time updates
// Clients can subscribe to receive live scrape progress and data updates

import { NextRequest } from 'next/server';

// Store active connections
const clients = new Set<ReadableStreamDefaultController>();

// Event types
type EventType = 'scrape_started' | 'scrape_progress' | 'scrape_completed' | 'provider_updated' | 'error';

interface SSEEvent {
  type: EventType;
  data: Record<string, unknown>;
  timestamp: string;
}

/**
 * Broadcast an event to all connected clients
 */
export function broadcastEvent(type: EventType, data: Record<string, unknown>) {
  const event: SSEEvent = {
    type,
    data,
    timestamp: new Date().toISOString(),
  };

  const message = `data: ${JSON.stringify(event)}\n\n`;

  clients.forEach((controller) => {
    try {
      controller.enqueue(new TextEncoder().encode(message));
    } catch {
      // Client disconnected, remove from set
      clients.delete(controller);
    }
  });
}

export async function GET(request: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Add this client to the set
      clients.add(controller);

      // Send initial connection message
      const connectMsg = `data: ${JSON.stringify({
        type: 'connected',
        timestamp: new Date().toISOString(),
        clientCount: clients.size,
      })}\n\n`;
      controller.enqueue(encoder.encode(connectMsg));

      // Send heartbeat every 30 seconds to keep connection alive
      const heartbeatInterval = setInterval(() => {
        try {
          const heartbeat = `data: ${JSON.stringify({ type: 'heartbeat', timestamp: new Date().toISOString() })}\n\n`;
          controller.enqueue(encoder.encode(heartbeat));
        } catch {
          clearInterval(heartbeatInterval);
          clients.delete(controller);
        }
      }, 30000);

      // Cleanup on close
      request.signal.addEventListener('abort', () => {
        clearInterval(heartbeatInterval);
        clients.delete(controller);
        controller.close();
      });
    },
    cancel() {
      // Client disconnected
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

// Export for use in other API routes
export { clients };
