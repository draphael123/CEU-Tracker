// GET /api/predictions - Get all provider predictions and organization metrics

import { NextResponse } from 'next/server';
import { getProviders, getCourseHistory, getProviderSummary } from '@/lib/data';
import {
  calculateRiskScore,
  generateForecast,
  generateAlerts,
  getAlertSummary,
  getRiskLevel,
} from '@/lib/predictions';
import type { ProviderPrediction, OrganizationMetrics } from '@/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [{ data: providers }, courseHistory, summary] = await Promise.all([
      getProviders({ limit: 1000 }),
      getCourseHistory(),
      getProviderSummary(),
    ]);

    // Build course lookup
    const coursesByProvider: Record<string, typeof courseHistory[string]['courses']> = {};
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
        daysUntilDeadline:
          provider.renewalDeadline !== null
            ? Math.round(
                (new Date(provider.renewalDeadline).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
              )
            : null,
        recommendedActions: generateRecommendedActions(provider, risk.score, forecast.completionProbability),
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

    const orgMetrics: OrganizationMetrics = {
      overallRiskScore: avgRiskScore,
      complianceRate: Math.round((summary.complete / summary.total) * 100),
      projectedComplianceRate: calculateProjectedComplianceRate(predictions),
      totalProviders: summary.total,
      criticalCount: predictions.filter((p) => p.riskLevel === 'critical').length,
      warningCount: predictions.filter((p) => p.riskLevel === 'high').length,
      onTrackCount: predictions.filter((p) => p.riskLevel === 'low' || p.riskLevel === 'medium').length,
      completeCount: summary.complete,
      trendsLast30Days: {
        riskScoreChange: 0, // Would need historical data
        complianceRateChange: 0, // Would need historical data
        coursesCompleted: 0, // Would calculate from course history
        hoursCompleted: 0, // Would calculate from course history
      },
    };

    return NextResponse.json({
      predictions,
      organizationMetrics: orgMetrics,
      alerts: alerts.slice(0, 20), // Top 20 alerts
      alertSummary,
    });
  } catch (error) {
    console.error('Error generating predictions:', error);
    return NextResponse.json({ error: 'Failed to generate predictions' }, { status: 500 });
  }
}

function generateRecommendedActions(
  provider: { hoursRemaining: number; state: string | null },
  riskScore: number,
  completionProbability: number
): ProviderPrediction['recommendedActions'] {
  const actions: ProviderPrediction['recommendedActions'] = [];

  if (provider.hoursRemaining <= 0) {
    return [
      {
        priority: 'low',
        action: 'Maintain compliance',
        reason: 'All requirements currently met',
        estimatedImpact: 'Stay compliant',
      },
    ];
  }

  if (riskScore >= 75) {
    actions.push({
      priority: 'high',
      action: 'Immediate action required',
      reason: 'Critical risk level detected',
      estimatedImpact: 'Prevent compliance failure',
    });
  }

  if (completionProbability < 50) {
    actions.push({
      priority: 'high',
      action: 'Increase course completion rate',
      reason: 'Current pace unlikely to meet deadline',
      estimatedImpact: 'Improve completion probability by 20-30%',
    });
  }

  if (provider.hoursRemaining > 10) {
    actions.push({
      priority: 'medium',
      action: `Complete ${Math.min(provider.hoursRemaining, 10)} hours of CEU`,
      reason: `${provider.hoursRemaining} hours still needed`,
      estimatedImpact: 'Reduce risk score by 10-15 points',
    });
  }

  if (actions.length === 0) {
    actions.push({
      priority: 'low',
      action: 'Continue current pace',
      reason: 'On track for completion',
      estimatedImpact: 'Maintain compliance',
    });
  }

  return actions;
}

function calculateProjectedComplianceRate(predictions: ProviderPrediction[]): number {
  if (predictions.length === 0) return 100;

  const likelyComplete = predictions.filter(
    (p) => p.completionProbability >= 70 || (p.daysUntilDeadline === null)
  ).length;

  return Math.round((likelyComplete / predictions.length) * 100);
}
