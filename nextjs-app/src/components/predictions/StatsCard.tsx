interface StatsCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  trend?: {
    value: number;
    label: string;
  };
  icon?: React.ReactNode;
  variant?: 'default' | 'success' | 'warning' | 'danger';
}

const variantStyles = {
  default: 'bg-white border-gray-200',
  success: 'bg-green-50 border-green-200',
  warning: 'bg-amber-50 border-amber-200',
  danger: 'bg-red-50 border-red-200',
};

const iconStyles = {
  default: 'bg-gray-100 text-gray-600',
  success: 'bg-green-100 text-green-600',
  warning: 'bg-amber-100 text-amber-600',
  danger: 'bg-red-100 text-red-600',
};

export function StatsCard({
  title,
  value,
  subtitle,
  trend,
  icon,
  variant = 'default',
}: StatsCardProps) {
  return (
    <div className={`rounded-xl border p-4 ${variantStyles[variant]}`}>
      <div className="flex items-start justify-between">
        <div>
          <div className="text-sm text-gray-500 mb-1">{title}</div>
          <div className="text-2xl font-bold text-gray-900">{value}</div>
          {subtitle && <div className="text-sm text-gray-500 mt-1">{subtitle}</div>}
          {trend && (
            <div
              className={`text-sm mt-2 flex items-center gap-1 ${
                trend.value >= 0 ? 'text-green-600' : 'text-red-600'
              }`}
            >
              {trend.value >= 0 ? (
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path
                    fillRule="evenodd"
                    d="M5.293 9.707a1 1 0 010-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 01-1.414 1.414L11 7.414V15a1 1 0 11-2 0V7.414L6.707 9.707a1 1 0 01-1.414 0z"
                    clipRule="evenodd"
                  />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path
                    fillRule="evenodd"
                    d="M14.707 10.293a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 111.414-1.414L9 12.586V5a1 1 0 012 0v7.586l2.293-2.293a1 1 0 011.414 0z"
                    clipRule="evenodd"
                  />
                </svg>
              )}
              <span>
                {Math.abs(trend.value)}% {trend.label}
              </span>
            </div>
          )}
        </div>
        {icon && (
          <div className={`p-2 rounded-lg ${iconStyles[variant]}`}>{icon}</div>
        )}
      </div>
    </div>
  );
}
