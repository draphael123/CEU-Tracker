import { getProviders, getCourseHistory, getProviderSummary } from '@/lib/data';
import {
  calculateRiskScore,
  generateForecast,
  generateAlerts,
  getAlertSummary,
} from '@/lib/predictions';
import { AlertsPanel, StatsCard, RiskScoreCard } from '@/components/predictions';
import Link from 'next/link';
import type { ProviderPrediction } from '@/types';

export const dynamic = 'force-dynamic';

export default async function PredictionsPage() {
  const [{ data: providers }, summary, courseHistory] = await Promise.all([
    getProviders({ limit: 1000 }),
    getProviderSummary(),
    getCourseHistory(),
  ]);

  // Build course lookup
  const coursesByProvider: Record<string, (typeof courseHistory)[string]['courses']> = {};
  Object.entries(courseHistory).forEach(([name, data]) => {
    coursesByProvider[name] = data.courses || [];
  });

  // Generate predictions for each provider
  const predictions: ProviderPrediction[] = providers.map((provider) => {
    const courses = coursesByProvider[provider.name] || [];
    const risk = calculateRiskScore(provider, courses);
    const forecast = generateForecast(provider, courses);

    return {
      providerId: provider.id,
      providerName: provider.name,
      riskScore: risk.score,
      riskLevel: risk.level,
      riskFactors: risk.factors,
      completionProbability: forecast.completionProbability,
      projectedCompletionDate: forecast.projectedCompletionDate,
      daysUntilDeadline: provider.renewalDeadline
        ? Math.round(
            (new Date(provider.renewalDeadline).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
          )
        : null,
      recommendedActions: [],
      confidence: risk.confidence,
      lastUpdated: new Date().toISOString(),
    };
  });

  // Generate all alerts
  const alerts = generateAlerts(providers, coursesByProvider);
  const alertSummary = getAlertSummary(alerts);

  // Calculate organization metrics
  const avgRiskScore =
    predictions.length > 0
      ? Math.round(predictions.reduce((sum, p) => sum + p.riskScore, 0) / predictions.length)
      : 0;

  const criticalCount = predictions.filter((p) => p.riskLevel === 'critical').length;
  const highRiskCount = predictions.filter((p) => p.riskLevel === 'high').length;
  const avgCompletionProb = Math.round(
    predictions.reduce((sum, p) => sum + p.completionProbability, 0) / predictions.length
  );

  // Sort predictions by risk score (highest first)
  const sortedPredictions = [...predictions].sort((a, b) => b.riskScore - a.riskScore);
  const topRisks = sortedPredictions.filter((p) => p.riskScore > 25).slice(0, 10);

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Predictions & Analytics</h1>
        <p className="text-gray-500">AI-powered compliance risk analysis and forecasting</p>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatsCard
          title="Avg Risk Score"
          value={avgRiskScore}
          subtitle="Organization-wide"
          variant={avgRiskScore < 25 ? 'success' : avgRiskScore < 50 ? 'warning' : 'danger'}
        />
        <StatsCard
          title="Critical Risks"
          value={criticalCount}
          subtitle="Immediate action needed"
          variant={criticalCount === 0 ? 'success' : 'danger'}
        />
        <StatsCard
          title="High Risks"
          value={highRiskCount}
          subtitle="Attention required"
          variant={highRiskCount === 0 ? 'success' : 'warning'}
        />
        <StatsCard
          title="Avg Completion Probability"
          value={`${avgCompletionProb}%`}
          subtitle="Likelihood of meeting deadlines"
          variant={avgCompletionProb >= 70 ? 'success' : avgCompletionProb >= 50 ? 'warning' : 'danger'}
        />
      </div>

      {/* Main content */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Alerts */}
        <div className="lg:col-span-1">
          <AlertsPanel alerts={alerts} maxItems={8} showViewAll={false} />
        </div>

        {/* High risk providers */}
        <div className="lg:col-span-2">
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100">
              <h2 className="font-semibold text-gray-900">Providers at Risk</h2>
              <p className="text-sm text-gray-500">Sorted by risk score (highest first)</p>
            </div>

            {topRisks.length > 0 ? (
              <div className="divide-y divide-gray-100">
                {topRisks.map((prediction) => (
                  <Link
                    key={prediction.providerId}
                    href={`/providers/${prediction.providerId}`}
                    className="block px-4 py-3 hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-gray-900">{prediction.providerName}</div>
                        <div className="text-sm text-gray-500">
                          {prediction.daysUntilDeadline !== null
                            ? prediction.daysUntilDeadline > 0
                              ? `${prediction.daysUntilDeadline} days until deadline`
                              : `${Math.abs(prediction.daysUntilDeadline)} days overdue`
                            : 'No deadline'}
                          {' | '}
                          {prediction.completionProbability}% completion probability
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div
                          className={`
                            px-3 py-1 rounded-full text-sm font-medium
                            ${prediction.riskLevel === 'critical' ? 'bg-red-100 text-red-700' : ''}
                            ${prediction.riskLevel === 'high' ? 'bg-orange-100 text-orange-700' : ''}
                            ${prediction.riskLevel === 'medium' ? 'bg-amber-100 text-amber-700' : ''}
                            ${prediction.riskLevel === 'low' ? 'bg-green-100 text-green-700' : ''}
                          `}
                        >
                          {prediction.riskScore}
                        </div>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="text-center py-12 text-gray-500">
                <div className="text-4xl mb-2">✓</div>
                <div>No high-risk providers</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Risk distribution */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <h2 className="font-semibold text-gray-900 mb-4">Risk Distribution</h2>
        <div className="grid grid-cols-4 gap-4">
          {(['low', 'medium', 'high', 'critical'] as const).map((level) => {
            const count = predictions.filter((p) => p.riskLevel === level).length;
            const percentage = Math.round((count / predictions.length) * 100);
            return (
              <div
                key={level}
                className={`
                  rounded-lg p-4 text-center
                  ${level === 'low' ? 'bg-green-50' : ''}
                  ${level === 'medium' ? 'bg-amber-50' : ''}
                  ${level === 'high' ? 'bg-orange-50' : ''}
                  ${level === 'critical' ? 'bg-red-50' : ''}
                `}
              >
                <div
                  className={`
                    text-2xl font-bold
                    ${level === 'low' ? 'text-green-700' : ''}
                    ${level === 'medium' ? 'text-amber-700' : ''}
                    ${level === 'high' ? 'text-orange-700' : ''}
                    ${level === 'critical' ? 'text-red-700' : ''}
                  `}
                >
                  {count}
                </div>
                <div className="text-sm text-gray-600 capitalize">{level}</div>
                <div className="text-xs text-gray-500">{percentage}%</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
