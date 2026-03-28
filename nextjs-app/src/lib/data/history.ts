// History data access layer

import { promises as fs } from 'fs';
import path from 'path';
import type {
  HistorySnapshot,
  CredentialHealthData,
  CredentialHealth,
  LastRunData,
  TrendDataPoint,
} from '@/types';
import { getProviderStatus } from '@/lib/utils';

const DATA_DIR = path.join(process.cwd(), 'data');

/**
 * Load and parse a JSON file from the data directory
 */
async function loadJsonFile<T>(filename: string): Promise<T | null> {
  try {
    const filePath = path.join(DATA_DIR, filename);
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch (error) {
    console.error(`Error loading ${filename}:`, error);
    return null;
  }
}

/**
 * Get all history snapshots
 */
export async function getHistorySnapshots(days?: number): Promise<HistorySnapshot[]> {
  const history = (await loadJsonFile<HistorySnapshot[]>('history.json')) || [];

  if (!days) return history;

  // Filter to last N days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  return history.filter((snapshot) => new Date(snapshot.timestamp) >= cutoff);
}

/**
 * Get the latest history snapshot
 */
export async function getLatestSnapshot(): Promise<HistorySnapshot | null> {
  const history = await getHistorySnapshots();
  return history.length > 0 ? history[history.length - 1] : null;
}

/**
 * Get credential health data
 */
export async function getCredentialHealth(): Promise<CredentialHealthData | null> {
  return loadJsonFile<CredentialHealthData>('credential-health.json');
}

/**
 * Get credential health for a specific provider/platform
 */
export async function getCredentialHealthFor(
  providerName: string,
  platform: string
): Promise<CredentialHealth | null> {
  const data = await getCredentialHealth();
  if (!data) return null;

  const key = `${providerName}|${platform}`;
  return data.credentials[key] || null;
}

/**
 * Get all credentials with issues (warning or critical status)
 */
export async function getCredentialsWithIssues(): Promise<CredentialHealth[]> {
  const data = await getCredentialHealth();
  if (!data) return [];

  return Object.values(data.credentials).filter(
    (cred) => cred.status === 'warning' || cred.status === 'critical'
  );
}

/**
 * Get the last run data
 */
export async function getLastRunData(): Promise<LastRunData | null> {
  return loadJsonFile<LastRunData>('last_run.json');
}

/**
 * Calculate trend data from history snapshots
 */
export async function getTrendData(days: number = 30): Promise<TrendDataPoint[]> {
  const history = await getHistorySnapshots(days);

  return history.map((snapshot) => {
    let complete = 0;
    let atRisk = 0;
    let inProgress = 0;

    snapshot.providers.forEach((provider) => {
      const status = getProviderStatus({
        hoursRemaining: provider.hoursRemaining,
        renewalDeadline: provider.renewalDeadline,
        hoursRequired: provider.hoursRequired,
      });

      switch (status) {
        case 'Complete':
          complete++;
          break;
        case 'At Risk':
          atRisk++;
          break;
        case 'In Progress':
          inProgress++;
          break;
      }
    });

    return {
      date: snapshot.timestamp.split('T')[0],
      complete,
      atRisk,
      inProgress,
      total: snapshot.providers.length,
    };
  });
}

/**
 * Get provider history over time
 */
export async function getProviderHistory(
  providerName: string,
  days: number = 30
): Promise<
  {
    date: string;
    hoursCompleted: number | null;
    hoursRemaining: number | null;
  }[]
> {
  const history = await getHistorySnapshots(days);

  return history
    .map((snapshot) => {
      const provider = snapshot.providers.find((p) => p.name === providerName);
      if (!provider) return null;

      return {
        date: snapshot.timestamp.split('T')[0],
        hoursCompleted: provider.hoursCompleted,
        hoursRemaining: provider.hoursRemaining,
      };
    })
    .filter(Boolean) as {
    date: string;
    hoursCompleted: number | null;
    hoursRemaining: number | null;
  }[];
}

/**
 * Calculate scraper success rate over time
 */
export async function getScraperSuccessRate(
  days: number = 30
): Promise<{ date: string; successRate: number }[]> {
  const history = await getHistorySnapshots(days);

  return history.map((snapshot) => ({
    date: snapshot.timestamp.split('T')[0],
    successRate:
      snapshot.succeeded + snapshot.failed > 0
        ? (snapshot.succeeded / (snapshot.succeeded + snapshot.failed)) * 100
        : 100,
  }));
}
