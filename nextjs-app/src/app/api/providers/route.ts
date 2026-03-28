// GET /api/providers - List providers with filtering

import { NextRequest, NextResponse } from 'next/server';
import { getProviders, getProviderSummary, type GetProvidersOptions } from '@/lib/data';
import type { ProviderStatus, Provider } from '@/types';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;

    const options: GetProvidersOptions = {
      status: (searchParams.get('status') as ProviderStatus) || undefined,
      state: searchParams.get('state') || undefined,
      type: (searchParams.get('type') as Provider['type']) || undefined,
      search: searchParams.get('search') || searchParams.get('q') || undefined,
      sortBy: (searchParams.get('sortBy') as GetProvidersOptions['sortBy']) || 'name',
      order: (searchParams.get('order') as 'asc' | 'desc') || 'asc',
      page: parseInt(searchParams.get('page') || '1', 10),
      limit: parseInt(searchParams.get('limit') || '50', 10),
    };

    const [result, summary] = await Promise.all([getProviders(options), getProviderSummary()]);

    return NextResponse.json({
      ...result,
      summary,
    });
  } catch (error) {
    console.error('Error fetching providers:', error);
    return NextResponse.json({ error: 'Failed to fetch providers' }, { status: 500 });
  }
}
