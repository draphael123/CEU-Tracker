// Provider-related type definitions

export type ProviderType = 'NP' | 'MD' | 'DO' | 'RN' | 'PA';
export type ProviderStatus = 'Complete' | 'At Risk' | 'In Progress' | 'Unknown';

export interface SubjectArea {
  name: string;
  hoursRequired: number;
  hoursCompleted: number;
  hoursRemaining: number;
  pattern?: string;
  lookbackYears?: number | null;
}

export interface Provider {
  id: string;
  name: string;
  type: ProviderType;
  state: string | null;
  licenseType: string;
  licenseNumber?: string;
  hoursRequired: number;
  hoursCompleted: number;
  hoursRemaining: number;
  renewalDeadline: string | null;
  subjectAreas: SubjectArea[];
  lastUpdated: string;
  status: ProviderStatus;
}

export interface ProviderRecord {
  providerName?: string;
  name?: string;
  providerType?: string;
  state: string | null;
  licenseType?: string;
  licenseNumber?: string;
  hoursRequired: number | null;
  hoursCompleted: number | null;
  hoursRemaining: number | null;
  renewalDeadline: string | null;
  subjectAreas?: SubjectArea[];
  lastUpdated?: string;
}

export interface Course {
  date: string;
  name: string;
  hours: number;
  state: string;
  platform?: string;
  cost?: number;
  scrapedAt?: string;
  category?: string;
}

export interface CourseHistory {
  courses: Course[];
  deadlines?: { state: string; deadline: string }[];
  type?: ProviderType;
  platformSpend?: Record<string, { total: number; count: number; avgCost: number }>;
}

export interface PlatformData {
  providerName: string;
  platform: string;
  status: 'success' | 'failed' | 'skipped';
  hoursEarned?: number;
  courses?: Course[];
  orders?: unknown[];
  error?: string;
}

export interface License {
  state: string;
  stateFullName: string;
  licenseNumber: string;
  licenseType: string;
  status: string;
  expirationDate: string | null;
  issuedDate: string | null;
  verificationSource: string;
  lastVerified: string;
  disciplineActions: boolean;
}

export interface ProviderLicenses {
  providerType: ProviderType;
  licenses: License[];
  statesSearched: number;
  statesWithLicense: number;
  lastFullScan: string;
}
