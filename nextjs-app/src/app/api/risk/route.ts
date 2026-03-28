import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';

// Risk calculation logic (mirrored from risk-prediction.js for Next.js)
interface RiskFactors {
  daysToDeadline: number;
  hoursRemaining: number;
  completionRate: number;
  courseFrequency: number;
  lastActivity: number;
}

interface Recommendation {
  priority: 'high' | 'medium' | 'low';
  category: string;
  message: string;
  action: string;
}

interface PredictedCompletion {
  likelihood: number | null;
  confidence: 'high' | 'medium' | 'low';
  requiredPacePerWeek?: number;
  message?: string;
}

interface RiskResult {
  score: number;
  percentage: number;
  level: 'critical' | 'high' | 'medium' | 'low' | 'minimal';
  factors: RiskFactors;
  recommendations: Recommendation[];
  predictedCompletion: PredictedCompletion;
}

interface Provider {
  name: string;
  type?: string;
  renewalDeadline?: string;
  hoursRemaining?: number;
  hoursRequired?: number;
  courses?: Array<{ name: string; hours: number; date: string }>;
}

const WEIGHTS = {
  daysToDeadline: 0.35,
  hoursRemaining: 0.25,
  completionRate: 0.20,
  courseFrequency: 0.10,
  lastActivity: 0.10,
};

const THRESHOLDS = {
  critical: 0.8,
  high: 0.6,
  medium: 0.4,
  low: 0.2,
};

function calculateDeadlineFactor(deadline?: string): number {
  if (!deadline) return 0.5;

  const daysRemaining = Math.ceil(
    (new Date(deadline).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  );

  if (daysRemaining < 0) return 1.0;
  if (daysRemaining <= 30) return 0.9;
  if (daysRemaining <= 60) return 0.7;
  if (daysRemaining <= 90) return 0.5;
  if (daysRemaining <= 180) return 0.3;
  return 0.1;
}

function calculateHoursFactor(hoursRemaining?: number, hoursRequired?: number): number {
  if (!hoursRequired || hoursRequired === 0) return 0;
  if (!hoursRemaining || hoursRemaining <= 0) return 0;

  const percentageRemaining = hoursRemaining / hoursRequired;

  if (percentageRemaining >= 1.0) return 1.0;
  if (percentageRemaining >= 0.75) return 0.8;
  if (percentageRemaining >= 0.50) return 0.6;
  if (percentageRemaining >= 0.25) return 0.3;
  return 0.1;
}

function calculateCompletionRate(courses: Array<{ date: string; hours: number }> = []): number {
  if (courses.length === 0) return 0.5;

  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);

  const recentCourses = courses.filter(c => new Date(c.date) >= twoYearsAgo);

  if (recentCourses.length === 0) return 0.7;

  const totalHours = recentCourses.reduce((sum, c) => sum + (c.hours || 0), 0);
  const avgHoursPerMonth = totalHours / 24;
  const paceRatio = avgHoursPerMonth / 2;

  if (paceRatio >= 1.0) return 0.1;
  if (paceRatio >= 0.75) return 0.3;
  if (paceRatio >= 0.5) return 0.5;
  if (paceRatio >= 0.25) return 0.7;
  return 0.9;
}

function calculateFrequencyFactor(courses: Array<{ date: string }> = []): number {
  if (courses.length < 3) return 0.5;

  const sortedDates = courses
    .map(c => new Date(c.date).getTime())
    .sort((a, b) => a - b);

  const gaps: number[] = [];
  for (let i = 1; i < sortedDates.length; i++) {
    gaps.push((sortedDates[i] - sortedDates[i - 1]) / (1000 * 60 * 60 * 24));
  }

  const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const variance = gaps.reduce((sum, gap) => sum + Math.pow(gap - avgGap, 2), 0) / gaps.length;
  const stdDev = Math.sqrt(variance);
  const coefficientOfVariation = stdDev / avgGap;

  if (coefficientOfVariation <= 0.3) return 0.1;
  if (coefficientOfVariation <= 0.5) return 0.3;
  if (coefficientOfVariation <= 0.7) return 0.5;
  if (coefficientOfVariation <= 1.0) return 0.7;
  return 0.9;
}

function calculateActivityFactor(lastCourseDate?: string): number {
  if (!lastCourseDate) return 0.7;

  const daysSinceLastCourse = Math.ceil(
    (Date.now() - new Date(lastCourseDate).getTime()) / (1000 * 60 * 60 * 24)
  );

  if (daysSinceLastCourse <= 30) return 0.1;
  if (daysSinceLastCourse <= 60) return 0.2;
  if (daysSinceLastCourse <= 90) return 0.3;
  if (daysSinceLastCourse <= 180) return 0.5;
  if (daysSinceLastCourse <= 365) return 0.7;
  return 0.9;
}

function getRiskLevel(score: number): 'critical' | 'high' | 'medium' | 'low' | 'minimal' {
  if (score >= THRESHOLDS.critical) return 'critical';
  if (score >= THRESHOLDS.high) return 'high';
  if (score >= THRESHOLDS.medium) return 'medium';
  if (score >= THRESHOLDS.low) return 'low';
  return 'minimal';
}

function generateRecommendations(factors: RiskFactors, provider: Provider): Recommendation[] {
  const recommendations: Recommendation[] = [];

  if (factors.daysToDeadline >= 0.7) {
    const daysLeft = provider.renewalDeadline
      ? Math.ceil((new Date(provider.renewalDeadline).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
      : null;
    recommendations.push({
      priority: 'high',
      category: 'deadline',
      message: `Deadline approaching${daysLeft ? ` in ${daysLeft} days` : ''}.`,
      action: 'Schedule dedicated time for CEU courses this week.',
    });
  }

  if (factors.hoursRemaining >= 0.6) {
    recommendations.push({
      priority: 'high',
      category: 'hours',
      message: `${provider.hoursRemaining || 'Multiple'} hours still needed.`,
      action: 'Consider intensive online courses to catch up quickly.',
    });
  }

  if (factors.lastActivity >= 0.6) {
    recommendations.push({
      priority: 'medium',
      category: 'activity',
      message: 'No recent course activity detected.',
      action: 'Start with a short course to rebuild momentum.',
    });
  }

  return recommendations.sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return order[a.priority] - order[b.priority];
  });
}

function calculateRisk(provider: Provider, courses: Array<{ date: string; hours: number }> = []): RiskResult {
  const lastCourseDate = courses.length > 0
    ? courses.reduce((latest, c) => {
        const d = new Date(c.date);
        return d > new Date(latest) ? c.date : latest;
      }, courses[0].date)
    : undefined;

  const factors: RiskFactors = {
    daysToDeadline: calculateDeadlineFactor(provider.renewalDeadline),
    hoursRemaining: calculateHoursFactor(provider.hoursRemaining, provider.hoursRequired),
    completionRate: calculateCompletionRate(courses),
    courseFrequency: calculateFrequencyFactor(courses),
    lastActivity: calculateActivityFactor(lastCourseDate),
  };

  let riskScore = 0;
  for (const [factor, weight] of Object.entries(WEIGHTS)) {
    riskScore += (factors[factor as keyof RiskFactors] || 0) * weight;
  }
  riskScore = Math.max(0, Math.min(1, riskScore));

  return {
    score: Math.round(riskScore * 100) / 100,
    percentage: Math.round(riskScore * 100),
    level: getRiskLevel(riskScore),
    factors,
    recommendations: generateRecommendations(factors, provider),
    predictedCompletion: {
      likelihood: riskScore < 0.5 ? 100 - Math.round(riskScore * 100) : Math.round((1 - riskScore) * 100),
      confidence: 'medium',
      message: riskScore < 0.5 ? 'On track to complete requirements.' : 'May need to increase completion pace.',
    },
  };
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const providerName = searchParams.get('provider');

    // Load provider data
    const dataPath = path.join(process.cwd(), '..', 'ceu-data-latest.json');

    if (!fs.existsSync(dataPath)) {
      return NextResponse.json({
        error: 'No data available. Run the scraper first.',
        timestamp: new Date().toISOString(),
      }, { status: 404 });
    }

    const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    const providers: Provider[] = data.providers || [];

    // Load course history if available
    const historyPath = path.join(process.cwd(), '..', 'course-history.json');
    let courseHistory: Record<string, Array<{ date: string; hours: number }>> = {};
    if (fs.existsSync(historyPath)) {
      courseHistory = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
    }

    if (providerName) {
      // Single provider risk analysis
      const provider = providers.find(p => p.name === providerName);
      if (!provider) {
        return NextResponse.json({ error: 'Provider not found' }, { status: 404 });
      }

      const courses = courseHistory[providerName] || [];
      const risk = calculateRisk(provider, courses);

      return NextResponse.json({
        provider: provider.name,
        type: provider.type,
        ...risk,
        timestamp: new Date().toISOString(),
      });
    }

    // All providers risk analysis
    const results = providers.map(provider => {
      const courses = courseHistory[provider.name] || [];
      const risk = calculateRisk(provider, courses);
      return {
        name: provider.name,
        type: provider.type,
        ...risk,
      };
    });

    // Summary stats
    const summary = {
      total: results.length,
      byLevel: {
        critical: results.filter(r => r.level === 'critical').length,
        high: results.filter(r => r.level === 'high').length,
        medium: results.filter(r => r.level === 'medium').length,
        low: results.filter(r => r.level === 'low').length,
        minimal: results.filter(r => r.level === 'minimal').length,
      },
      averageRisk: results.length > 0
        ? Math.round((results.reduce((sum, r) => sum + r.score, 0) / results.length) * 100) / 100
        : 0,
      highestRisk: results.reduce((highest, r) => (!highest || r.score > highest.score) ? r : highest, null as typeof results[0] | null),
    };

    return NextResponse.json({
      summary,
      providers: results.sort((a, b) => b.score - a.score),
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Risk prediction error:', error);
    return NextResponse.json({
      error: 'Failed to calculate risk predictions',
      details: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}
