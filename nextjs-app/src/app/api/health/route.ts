import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  version: string;
  uptime: number;
  checks: {
    dataFiles: {
      status: 'ok' | 'error';
      files: Record<string, { exists: boolean; lastModified?: string; sizeKB?: number }>;
    };
    lastRun: {
      status: 'ok' | 'stale' | 'error';
      timestamp?: string;
      ageHours?: number;
    };
    credentialHealth: {
      status: 'ok' | 'degraded' | 'error';
      summary?: {
        healthy: number;
        degraded: number;
        critical: number;
      };
    };
  };
}

const DATA_DIR = path.join(process.cwd(), 'data');

function checkDataFiles(): HealthStatus['checks']['dataFiles'] {
  const requiredFiles = [
    'history.json',
    'course-history.json',
    'credential-health.json',
    'last_run.json',
  ];

  const files: Record<string, { exists: boolean; lastModified?: string; sizeKB?: number }> = {};
  let allExist = true;

  for (const file of requiredFiles) {
    const filePath = path.join(DATA_DIR, file);
    try {
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        files[file] = {
          exists: true,
          lastModified: stats.mtime.toISOString(),
          sizeKB: Math.round(stats.size / 1024),
        };
      } else {
        files[file] = { exists: false };
        allExist = false;
      }
    } catch {
      files[file] = { exists: false };
      allExist = false;
    }
  }

  return {
    status: allExist ? 'ok' : 'error',
    files,
  };
}

function checkLastRun(): HealthStatus['checks']['lastRun'] {
  const lastRunPath = path.join(DATA_DIR, 'last_run.json');

  try {
    if (!fs.existsSync(lastRunPath)) {
      return { status: 'error' };
    }

    const data = JSON.parse(fs.readFileSync(lastRunPath, 'utf-8'));
    const lastRunTime = new Date(data.timestamp || data.lastRun);
    const ageMs = Date.now() - lastRunTime.getTime();
    const ageHours = Math.round(ageMs / (1000 * 60 * 60));

    // Consider stale if older than 48 hours
    const isStale = ageHours > 48;

    return {
      status: isStale ? 'stale' : 'ok',
      timestamp: lastRunTime.toISOString(),
      ageHours,
    };
  } catch {
    return { status: 'error' };
  }
}

function checkCredentialHealth(): HealthStatus['checks']['credentialHealth'] {
  const healthPath = path.join(DATA_DIR, 'credential-health.json');

  try {
    if (!fs.existsSync(healthPath)) {
      return { status: 'ok', summary: { healthy: 0, degraded: 0, critical: 0 } };
    }

    const data = JSON.parse(fs.readFileSync(healthPath, 'utf-8'));
    const providers = Object.values(data.providers || {}) as Array<{ status: string }>;

    const summary = {
      healthy: providers.filter(p => p.status === 'healthy').length,
      degraded: providers.filter(p => p.status === 'degraded' || p.status === 'warning').length,
      critical: providers.filter(p => p.status === 'critical').length,
    };

    let status: 'ok' | 'degraded' | 'error' = 'ok';
    if (summary.critical > 0) {
      status = 'error';
    } else if (summary.degraded > 0) {
      status = 'degraded';
    }

    return { status, summary };
  } catch {
    return { status: 'error' };
  }
}

export async function GET() {
  const startTime = process.hrtime();

  const checks = {
    dataFiles: checkDataFiles(),
    lastRun: checkLastRun(),
    credentialHealth: checkCredentialHealth(),
  };

  // Determine overall status
  let overallStatus: HealthStatus['status'] = 'healthy';

  if (
    checks.dataFiles.status === 'error' ||
    checks.lastRun.status === 'error' ||
    checks.credentialHealth.status === 'error'
  ) {
    overallStatus = 'unhealthy';
  } else if (
    checks.lastRun.status === 'stale' ||
    checks.credentialHealth.status === 'degraded'
  ) {
    overallStatus = 'degraded';
  }

  const response: HealthStatus = {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    uptime: process.uptime(),
    checks,
  };

  const [seconds, nanoseconds] = process.hrtime(startTime);
  const responseTimeMs = (seconds * 1000 + nanoseconds / 1000000).toFixed(2);

  return NextResponse.json(response, {
    status: overallStatus === 'unhealthy' ? 503 : 200,
    headers: {
      'X-Response-Time': `${responseTimeMs}ms`,
      'Cache-Control': 'no-store',
    },
  });
}
