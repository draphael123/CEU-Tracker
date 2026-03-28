import type { Alert, AlertSeverity } from '@/types';
import Link from 'next/link';
import type { ReactNode } from 'react';

interface AlertsPanelProps {
  alerts: Alert[];
  maxItems?: number;
  showViewAll?: boolean;
}

const severityStyles: Record<AlertSeverity, { bg: string; border: string; icon: string }> = {
  critical: {
    bg: 'bg-red-50',
    border: 'border-red-200',
    icon: 'text-red-500',
  },
  warning: {
    bg: 'bg-amber-50',
    border: 'border-amber-200',
    icon: 'text-amber-500',
  },
  info: {
    bg: 'bg-blue-50',
    border: 'border-blue-200',
    icon: 'text-blue-500',
  },
};

const severityIcons: Record<AlertSeverity, ReactNode> = {
  critical: (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
      <path
        fillRule="evenodd"
        d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
        clipRule="evenodd"
      />
    </svg>
  ),
  warning: (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
      <path
        fillRule="evenodd"
        d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
        clipRule="evenodd"
      />
    </svg>
  ),
  info: (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
      <path
        fillRule="evenodd"
        d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
        clipRule="evenodd"
      />
    </svg>
  ),
};

export function AlertsPanel({ alerts, maxItems = 5, showViewAll = true }: AlertsPanelProps) {
  const displayAlerts = alerts.slice(0, maxItems);

  if (alerts.length === 0) {
    return (
      <div className="bg-green-50 border border-green-200 rounded-xl p-6 text-center">
        <div className="text-green-500 text-3xl mb-2">✓</div>
        <div className="text-green-700 font-medium">All Clear</div>
        <div className="text-green-600 text-sm">No alerts at this time</div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-gray-900">Alerts</h3>
          <span className="px-2 py-0.5 bg-red-100 text-red-700 text-xs font-medium rounded-full">
            {alerts.length}
          </span>
        </div>
        <div className="flex gap-2 text-xs">
          <span className="text-red-600">
            {alerts.filter((a) => a.severity === 'critical').length} critical
          </span>
          <span className="text-amber-600">
            {alerts.filter((a) => a.severity === 'warning').length} warning
          </span>
        </div>
      </div>

      {/* Alert list */}
      <div className="divide-y divide-gray-100">
        {displayAlerts.map((alert) => {
          const styles = severityStyles[alert.severity];
          return (
            <Link
              key={alert.id}
              href={`/providers/${alert.providerId}`}
              className={`block px-4 py-3 hover:bg-gray-50 transition-colors`}
            >
              <div className="flex gap-3">
                <div className={`flex-shrink-0 ${styles.icon}`}>
                  {severityIcons[alert.severity]}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-gray-900 text-sm">{alert.title}</div>
                  <div className="text-gray-500 text-sm truncate">{alert.message}</div>
                  <div className="text-gray-400 text-xs mt-1">{alert.providerName}</div>
                </div>
              </div>
            </Link>
          );
        })}
      </div>

      {/* View all link */}
      {showViewAll && alerts.length > maxItems && (
        <div className="px-4 py-3 border-t border-gray-100 bg-gray-50">
          <Link
            href="/predictions?tab=alerts"
            className="text-sm text-indigo-600 hover:text-indigo-700 font-medium"
          >
            View all {alerts.length} alerts →
          </Link>
        </div>
      )}
    </div>
  );
}
