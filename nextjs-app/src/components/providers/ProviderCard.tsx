import Link from 'next/link';
import type { Provider } from '@/types';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { daysUntil, formatDate } from '@/lib/utils';

interface ProviderCardProps {
  provider: Provider;
  riskScore?: number;
}

export function ProviderCard({ provider, riskScore }: ProviderCardProps) {
  const days = daysUntil(provider.renewalDeadline);
  const progress =
    provider.hoursRequired > 0
      ? Math.round((provider.hoursCompleted / provider.hoursRequired) * 100)
      : 100;

  // Get card border color based on status
  const borderColor =
    provider.status === 'Complete'
      ? 'border-green-200 hover:border-green-300'
      : provider.status === 'At Risk'
        ? 'border-red-200 hover:border-red-300'
        : provider.status === 'In Progress'
          ? 'border-amber-200 hover:border-amber-300'
          : 'border-gray-200 hover:border-gray-300';

  return (
    <Link href={`/providers/${provider.id}`}>
      <div
        className={`
          bg-white rounded-xl border-2 p-4 shadow-sm
          hover:shadow-md transition-all cursor-pointer
          ${borderColor}
        `}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-gray-900 truncate">{provider.name}</h3>
            <p className="text-sm text-gray-500">
              {provider.type} • {provider.state || 'Unknown'}
            </p>
          </div>
          <StatusBadge status={provider.status} size="sm" />
        </div>

        {/* Progress */}
        <div className="mb-3">
          <div className="flex justify-between text-sm mb-1">
            <span className="text-gray-600">
              {provider.hoursCompleted} / {provider.hoursRequired} hrs
            </span>
            <span className="font-medium">{progress}%</span>
          </div>
          <ProgressBar value={provider.hoursCompleted} max={provider.hoursRequired} size="md" />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between text-sm">
          <div className="text-gray-500">
            {days !== null ? (
              days > 0 ? (
                <span>
                  {days} days left
                </span>
              ) : days === 0 ? (
                <span className="text-red-600 font-medium">Due today</span>
              ) : (
                <span className="text-red-600 font-medium">
                  {Math.abs(days)} days overdue
                </span>
              )
            ) : (
              <span>No deadline</span>
            )}
          </div>

          {/* Risk score indicator */}
          {riskScore !== undefined && riskScore > 0 && (
            <div
              className={`
                px-2 py-0.5 rounded text-xs font-medium
                ${riskScore >= 75 ? 'bg-red-100 text-red-700' : ''}
                ${riskScore >= 50 && riskScore < 75 ? 'bg-orange-100 text-orange-700' : ''}
                ${riskScore >= 25 && riskScore < 50 ? 'bg-amber-100 text-amber-700' : ''}
                ${riskScore < 25 ? 'bg-green-100 text-green-700' : ''}
              `}
            >
              Risk: {riskScore}
            </div>
          )}

          {provider.hoursRemaining > 0 && (
            <span className="text-gray-500">
              {provider.hoursRemaining} hrs needed
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}
