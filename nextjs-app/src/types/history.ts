// History and time-series data type definitions

export interface HistoryProviderSnapshot {
  name: string;
  state: string | null;
  hoursRequired: number | null;
  hoursCompleted: number | null;
  hoursRemaining: number | null;
  renewalDeadline: string | null;
}

export interface HistorySnapshot {
  timestamp: string;
  succeeded: number;
  failed: number;
  providers: HistoryProviderSnapshot[];
}

export interface CredentialHealth {
  providerName: string;
  platform: string;
  consecutiveFailures: number;
  lastSuccess: string | null;
  lastFailure: string | null;
  failureHistory: { timestamp: string; error: string }[];
  status: 'healthy' | 'degraded' | 'warning' | 'critical';
  lastError?: string;
}

export interface CredentialHealthData {
  lastUpdated: string;
  credentials: Record<string, CredentialHealth>;
}

export interface LastRunData {
  timestamp: string;
  total: number;
  succeeded: number;
  failed: number;
}

export interface TrendDataPoint {
  date: string;
  complete: number;
  atRisk: number;
  inProgress: number;
  total: number;
}
