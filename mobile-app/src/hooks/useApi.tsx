import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';

const API_BASE_URL = 'https://ceu-tracker.vercel.app/api';

interface Provider {
  name: string;
  type: string;
  state?: string;
  renewalDeadline?: string;
  hoursRequired?: number;
  hoursCompleted?: number;
  hoursRemaining?: number;
  status?: 'Complete' | 'In Progress' | 'At Risk' | 'Unknown';
  courses?: Course[];
}

interface Course {
  name: string;
  hours: number;
  date: string;
  platform?: string;
  category?: string;
}

interface DashboardStats {
  totalProviders: number;
  complete: number;
  inProgress: number;
  atRisk: number;
  lastUpdated: string;
}

interface ApiContextType {
  providers: Provider[];
  stats: DashboardStats | null;
  loading: boolean;
  error: string | null;
  refreshData: () => Promise<void>;
  getProvider: (name: string) => Provider | undefined;
}

const ApiContext = createContext<ApiContextType | null>(null);

export function ApiProvider({ children }: { children: ReactNode }) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`${API_BASE_URL}/data`);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();

      if (data.providers) {
        setProviders(data.providers);
      }

      // Calculate stats from providers
      const totalProviders = data.providers?.length || 0;
      const complete = data.providers?.filter((p: Provider) => p.status === 'Complete').length || 0;
      const atRisk = data.providers?.filter((p: Provider) => p.status === 'At Risk').length || 0;
      const inProgress = data.providers?.filter((p: Provider) => p.status === 'In Progress').length || 0;

      setStats({
        totalProviders,
        complete,
        inProgress,
        atRisk,
        lastUpdated: data.lastUpdated || new Date().toISOString(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setLoading(false);
    }
  }, []);

  const getProvider = useCallback(
    (name: string) => {
      return providers.find((p) => p.name === name);
    },
    [providers]
  );

  return (
    <ApiContext.Provider
      value={{
        providers,
        stats,
        loading,
        error,
        refreshData,
        getProvider,
      }}
    >
      {children}
    </ApiContext.Provider>
  );
}

export function useApi() {
  const context = useContext(ApiContext);
  if (!context) {
    throw new Error('useApi must be used within an ApiProvider');
  }
  return context;
}

export default useApi;
