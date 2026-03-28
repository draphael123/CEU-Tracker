import { Suspense } from 'react';
import { getProviders, getProviderSummary, getCourseHistory } from '@/lib/data';
import { calculateRiskScore } from '@/lib/predictions';
import { ProviderGrid, ProviderFilters } from '@/components/providers';
import type { ProviderStatus, Provider } from '@/types';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{
    status?: string;
    state?: string;
    type?: string;
    q?: string;
    sortBy?: string;
    order?: string;
  }>;
}

export default async function ProvidersPage({ searchParams }: PageProps) {
  const params = await searchParams;

  const [{ data: providers, pagination }, summary, courseHistory] = await Promise.all([
    getProviders({
      status: params.status as ProviderStatus,
      state: params.state,
      type: params.type as Provider['type'],
      search: params.q,
      sortBy: params.sortBy as 'name' | 'deadline' | 'hoursRemaining',
      order: params.order as 'asc' | 'desc',
      limit: 100,
    }),
    getProviderSummary(),
    getCourseHistory(),
  ]);

  // Build course lookup
  const coursesByProvider: Record<string, (typeof courseHistory)[string]['courses']> = {};
  Object.entries(courseHistory).forEach(([name, data]) => {
    coursesByProvider[name] = data.courses || [];
  });

  // Calculate risk scores
  const riskScores: Record<string, number> = {};
  providers.forEach((provider) => {
    const courses = coursesByProvider[provider.name] || [];
    const risk = calculateRiskScore(provider, courses);
    riskScores[provider.id] = risk.score;
  });

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Providers</h1>
        <p className="text-gray-500">Manage and track CEU compliance for all providers</p>
      </div>

      {/* Filters */}
      <Suspense fallback={<div className="h-24 bg-gray-100 rounded-lg animate-pulse" />}>
        <ProviderFilters
          states={summary.states}
          types={summary.types}
          totalCount={summary.total}
          filteredCount={pagination.total}
        />
      </Suspense>

      {/* Provider grid */}
      <ProviderGrid providers={providers} riskScores={riskScores} />

      {/* Pagination info */}
      {pagination.total > pagination.limit && (
        <div className="text-center text-sm text-gray-500">
          Showing {providers.length} of {pagination.total} providers
        </div>
      )}
    </div>
  );
}
