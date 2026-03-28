// GET /api/providers/[id] - Get provider detail with courses and predictions

import { NextRequest, NextResponse } from 'next/server';
import {
  getProviderById,
  getProviderCourses,
  getProviderPlatformData,
  getProviderLicenses,
} from '@/lib/data';
import { calculateRiskScore, generateForecast, generateProviderAlerts } from '@/lib/predictions';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const provider = await getProviderById(id);

    if (!provider) {
      return NextResponse.json({ error: 'Provider not found' }, { status: 404 });
    }

    // Fetch related data
    const [courses, platformData, licenses] = await Promise.all([
      getProviderCourses(provider.name),
      getProviderPlatformData(provider.name),
      getProviderLicenses(provider.name),
    ]);

    // Generate predictions
    const riskAssessment = calculateRiskScore(provider, courses);
    const forecast = generateForecast(provider, courses);
    const alerts = generateProviderAlerts(provider, courses);

    return NextResponse.json({
      provider,
      courses,
      platformData,
      licenses,
      predictions: {
        riskScore: riskAssessment.score,
        riskLevel: riskAssessment.level,
        riskFactors: riskAssessment.factors,
        completionProbability: forecast.completionProbability,
        projectedCompletionDate: forecast.projectedCompletionDate,
        scenarios: forecast.scenarios,
        confidence: riskAssessment.confidence,
      },
      alerts,
    });
  } catch (error) {
    console.error('Error fetching provider:', error);
    return NextResponse.json({ error: 'Failed to fetch provider' }, { status: 500 });
  }
}
