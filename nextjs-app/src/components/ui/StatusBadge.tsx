import type { ProviderStatus, RiskLevel, AlertSeverity } from '@/types';

interface StatusBadgeProps {
  status: ProviderStatus | RiskLevel | AlertSeverity;
  size?: 'sm' | 'md' | 'lg';
}

const statusStyles: Record<string, string> = {
  // Provider status
  Complete: 'bg-green-100 text-green-700 border-green-200',
  'At Risk': 'bg-red-100 text-red-700 border-red-200',
  'In Progress': 'bg-amber-100 text-amber-700 border-amber-200',
  Unknown: 'bg-gray-100 text-gray-700 border-gray-200',
  // Risk levels
  low: 'bg-green-100 text-green-700 border-green-200',
  medium: 'bg-amber-100 text-amber-700 border-amber-200',
  high: 'bg-orange-100 text-orange-700 border-orange-200',
  critical: 'bg-red-100 text-red-700 border-red-200',
  // Alert severity
  info: 'bg-blue-100 text-blue-700 border-blue-200',
  warning: 'bg-amber-100 text-amber-700 border-amber-200',
};

const sizeStyles = {
  sm: 'px-2 py-0.5 text-xs',
  md: 'px-2.5 py-1 text-sm',
  lg: 'px-3 py-1.5 text-base',
};

export function StatusBadge({ status, size = 'md' }: StatusBadgeProps) {
  const style = statusStyles[status] || statusStyles.Unknown;
  const sizeStyle = sizeStyles[size];

  return (
    <span
      className={`inline-flex items-center font-medium rounded-full border ${style} ${sizeStyle}`}
    >
      {status}
    </span>
  );
}
