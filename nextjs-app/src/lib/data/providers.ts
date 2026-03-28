// Provider data access layer

import { promises as fs } from 'fs';
import path from 'path';
import type {
  Provider,
  ProviderRecord,
  ProviderStatus,
  CourseHistory,
  PlatformData,
  ProviderLicenses,
  Course,
} from '@/types';
import { getProviderStatus, daysUntil } from '@/lib/utils';

const DATA_DIR = path.join(process.cwd(), 'data');

// Cache for data (refreshed on each request in dev, cached in prod)
let historyCache: HistorySnapshot[] | null = null;
let courseHistoryCache: Record<string, CourseHistory> | null = null;
let platformDataCache: PlatformData[] | null = null;
let licensesCache: Record<string, ProviderLicenses> | null = null;

interface HistorySnapshot {
  timestamp: string;
  succeeded: number;
  failed: number;
  providers: ProviderRecord[];
}

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
 * Get the latest history snapshot
 */
async function getLatestSnapshot(): Promise<HistorySnapshot | null> {
  if (!historyCache) {
    historyCache = (await loadJsonFile<HistorySnapshot[]>('history.json')) || [];
  }
  return historyCache.length > 0 ? historyCache[historyCache.length - 1] : null;
}

/**
 * Get all history snapshots (internal use)
 */
async function getAllSnapshots(): Promise<HistorySnapshot[]> {
  if (!historyCache) {
    historyCache = (await loadJsonFile<HistorySnapshot[]>('history.json')) || [];
  }
  return historyCache;
}

/**
 * Get course history for all providers
 */
export async function getCourseHistory(): Promise<Record<string, CourseHistory>> {
  if (!courseHistoryCache) {
    courseHistoryCache =
      (await loadJsonFile<Record<string, CourseHistory>>('course-history.json')) || {};
  }
  return courseHistoryCache;
}

/**
 * Get platform data for all providers
 */
export async function getPlatformData(): Promise<PlatformData[]> {
  if (!platformDataCache) {
    platformDataCache = (await loadJsonFile<PlatformData[]>('platform-data.json')) || [];
  }
  return platformDataCache;
}

/**
 * Get license data for all providers
 */
async function getLicensesData(): Promise<{
  lastUpdated: string;
  providers: Record<string, ProviderLicenses>;
} | null> {
  return loadJsonFile('licenses.json');
}

/**
 * Convert a provider record to a Provider with computed fields
 */
function toProvider(record: ProviderRecord, id: string): Provider {
  const status = getProviderStatus({
    hoursRemaining: record.hoursRemaining,
    renewalDeadline: record.renewalDeadline,
    hoursRequired: record.hoursRequired,
  });

  return {
    id,
    name: record.providerName || record.name || '',
    type: (record.providerType as Provider['type']) || 'NP',
    state: record.state,
    licenseType: record.licenseType || '',
    licenseNumber: record.licenseNumber,
    hoursRequired: record.hoursRequired || 0,
    hoursCompleted: record.hoursCompleted || 0,
    hoursRemaining: record.hoursRemaining || 0,
    renewalDeadline: record.renewalDeadline,
    subjectAreas: record.subjectAreas || [],
    lastUpdated: record.lastUpdated || new Date().toISOString(),
    status,
  };
}

/**
 * Generate a stable ID from provider name
 */
function generateProviderId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export interface GetProvidersOptions {
  status?: ProviderStatus | 'all';
  state?: string | 'all';
  type?: Provider['type'] | 'all';
  search?: string;
  sortBy?: 'name' | 'deadline' | 'hoursRemaining' | 'riskScore' | 'state';
  order?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

/**
 * Get providers with filtering, sorting, and pagination
 */
export async function getProviders(
  options: GetProvidersOptions = {}
): Promise<PaginatedResult<Provider>> {
  const snapshot = await getLatestSnapshot();
  if (!snapshot) {
    return {
      data: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    };
  }

  // Convert records to Providers
  let providers = snapshot.providers.map((record) => {
    const name = record.providerName || record.name || 'Unknown';
    return toProvider(record as ProviderRecord, generateProviderId(name));
  });

  // Apply filters
  if (options.status && options.status !== 'all') {
    providers = providers.filter((p) => p.status === options.status);
  }

  if (options.state && options.state !== 'all') {
    providers = providers.filter((p) => p.state === options.state);
  }

  if (options.type && options.type !== 'all') {
    providers = providers.filter((p) => p.type === options.type);
  }

  if (options.search) {
    const q = options.search.toLowerCase();
    providers = providers.filter(
      (p) => p.name.toLowerCase().includes(q) || p.state?.toLowerCase().includes(q)
    );
  }

  // Sort
  const sortBy = options.sortBy || 'name';
  const order = options.order === 'desc' ? -1 : 1;

  providers.sort((a, b) => {
    switch (sortBy) {
      case 'deadline': {
        const daysA = daysUntil(a.renewalDeadline) ?? 9999;
        const daysB = daysUntil(b.renewalDeadline) ?? 9999;
        return (daysA - daysB) * order;
      }
      case 'hoursRemaining':
        return (a.hoursRemaining - b.hoursRemaining) * order;
      case 'state':
        return (a.state || '').localeCompare(b.state || '') * order;
      case 'name':
      default:
        return a.name.localeCompare(b.name) * order;
    }
  });

  // Paginate
  const page = options.page || 1;
  const limit = options.limit || 50;
  const total = providers.length;
  const start = (page - 1) * limit;
  const paginatedData = providers.slice(start, start + limit);

  return {
    data: paginatedData,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

/**
 * Get a single provider by ID
 */
export async function getProviderById(id: string): Promise<Provider | null> {
  const { data: providers } = await getProviders({ limit: 1000 });
  return providers.find((p) => p.id === id) || null;
}

/**
 * Get courses for a provider
 */
export async function getProviderCourses(providerName: string): Promise<Course[]> {
  const courseHistory = await getCourseHistory();
  const history = courseHistory[providerName];
  return history?.courses || [];
}

/**
 * Get platform data for a provider
 */
export async function getProviderPlatformData(providerName: string): Promise<PlatformData[]> {
  const platformData = await getPlatformData();
  return platformData.filter((p) => p.providerName === providerName);
}

/**
 * Get licenses for a provider
 */
export async function getProviderLicenses(
  providerName: string
): Promise<ProviderLicenses | null> {
  const licensesData = await getLicensesData();
  return licensesData?.providers?.[providerName] || null;
}

/**
 * Get summary statistics
 */
export async function getProviderSummary(): Promise<{
  total: number;
  complete: number;
  atRisk: number;
  inProgress: number;
  unknown: number;
  states: string[];
  types: Provider['type'][];
}> {
  const { data: providers } = await getProviders({ limit: 1000 });

  const summary = {
    total: providers.length,
    complete: 0,
    atRisk: 0,
    inProgress: 0,
    unknown: 0,
    states: new Set<string>(),
    types: new Set<Provider['type']>(),
  };

  providers.forEach((p) => {
    switch (p.status) {
      case 'Complete':
        summary.complete++;
        break;
      case 'At Risk':
        summary.atRisk++;
        break;
      case 'In Progress':
        summary.inProgress++;
        break;
      default:
        summary.unknown++;
    }
    if (p.state) summary.states.add(p.state);
    if (p.type) summary.types.add(p.type);
  });

  return {
    ...summary,
    states: Array.from(summary.states).sort(),
    types: Array.from(summary.types).sort(),
  };
}

/**
 * Clear caches (useful for development/testing)
 */
export function clearCaches(): void {
  historyCache = null;
  courseHistoryCache = null;
  platformDataCache = null;
  licensesCache = null;
}
