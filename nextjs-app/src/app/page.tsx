import { getProviders, getProviderSummary, getCourseHistory } from '@/lib/data';
import { generateAlerts, getAlertSummary, calculateRiskScore } from '@/lib/predictions';
import { ProviderGrid } from '@/components/providers';
import { AlertsPanel, StatsCard } from '@/components/predictions';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const [{ data: providers }, summary, courseHistory] = await Promise.all([
    getProviders({ limit: 100 }),
    getProviderSummary(),
    getCourseHistory(),
  ]);

  // Build course lookup and generate alerts
  const coursesByProvider: Record<string, (typeof courseHistory)[string]['courses']> = {};
  Object.entries(courseHistory).forEach(([name, data]) => {
    coursesByProvider[name] = data.courses || [];
  });

  const alerts = generateAlerts(providers, coursesByProvider);

  // Calculate risk scores for display
  const riskScores: Record<string, number> = {};
  providers.forEach((provider) => {
    const courses = coursesByProvider[provider.name] || [];
    const risk = calculateRiskScore(provider, courses);
    riskScores[provider.id] = risk.score;
  });

  // Get at-risk and upcoming deadline providers
  const atRiskProviders = providers.filter((p) => p.status === 'At Risk').slice(0, 6);
  const upcomingDeadlines = providers
    .filter((p) => p.hoursRemaining > 0 && p.renewalDeadline)
    .sort((a, b) => {
      const dateA = new Date(a.renewalDeadline!).getTime();
      const dateB = new Date(b.renewalDeadline!).getTime();
      return dateA - dateB;
    })
    .slice(0, 6);

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-gray-500">Overview of CEU compliance status</p>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatsCard
          title="Total Providers"
          value={summary.total}
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
          }
        />
        <StatsCard
          title="Complete"
          value={summary.complete}
          subtitle={`${Math.round((summary.complete / summary.total) * 100)}% compliance`}
          variant="success"
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          }
        />
        <StatsCard
          title="At Risk"
          value={summary.atRisk}
          subtitle="Need attention"
          variant="danger"
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          }
        />
        <StatsCard
          title="In Progress"
          value={summary.inProgress}
          subtitle="Working on CEUs"
          variant="warning"
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          }
        />
      </div>

      {/* Main content grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Alerts panel */}
        <div className="lg:col-span-1">
          <AlertsPanel alerts={alerts} maxItems={5} showViewAll />
        </div>

        {/* At risk providers */}
        <div className="lg:col-span-2">
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold text-gray-900">At Risk Providers</h2>
              <Link
                href="/providers?status=At%20Risk"
                className="text-sm text-indigo-600 hover:text-indigo-700"
              >
                View all
              </Link>
            </div>
            {atRiskProviders.length > 0 ? (
              <ProviderGrid providers={atRiskProviders} riskScores={riskScores} />
            ) : (
              <div className="text-center py-8 text-gray-500">
                No providers at risk
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Upcoming deadlines */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-gray-900">Upcoming Deadlines</h2>
          <Link
            href="/providers?sortBy=deadline"
            className="text-sm text-indigo-600 hover:text-indigo-700"
          >
            View all
          </Link>
        </div>
        <ProviderGrid providers={upcomingDeadlines} riskScores={riskScores} />
      </div>
    </div>
  );
}
