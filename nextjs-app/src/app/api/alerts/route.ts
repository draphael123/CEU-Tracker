// GET /api/alerts - Get all alerts sorted by severity

import { NextRequest, NextResponse } from 'next/server';
import { getProviders, getCourseHistory } from '@/lib/data';
import { generateAlerts, getAlertSummary, filterAlertsBySeverity } from '@/lib/predictions';
import type { AlertSeverity } from '@/types';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const severity = searchParams.get('severity') as AlertSeverity | 'all' | null;
    const limit = parseInt(searchParams.get('limit') || '50', 10);

    const [{ data: providers }, courseHistory] = await Promise.all([
      getProviders({ limit: 1000 }),
      getCourseHistory(),
    ]);

    // Build course lookup
    const coursesByProvider: Record<string, typeof courseHistory[string]['courses']> = {};
    Object.entries(courseHistory).forEach(([name, data]) => {
      coursesByProvider[name] = data.courses || [];
    });

    // Generate alerts
    let alerts = generateAlerts(providers, coursesByProvider);

    // Filter by severity if specified
    if (severity && severity !== 'all') {
      alerts = filterAlertsBySeverity(alerts, severity);
    }

    // Apply limit
    const limitedAlerts = alerts.slice(0, limit);

    return NextResponse.json({
      alerts: limitedAlerts,
      summary: getAlertSummary(alerts),
      total: alerts.length,
    });
  } catch (error) {
    console.error('Error fetching alerts:', error);
    return NextResponse.json({ error: 'Failed to fetch alerts' }, { status: 500 });
  }
}
