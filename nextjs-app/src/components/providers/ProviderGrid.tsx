import type { Provider } from '@/types';
import { ProviderCard } from './ProviderCard';

interface ProviderGridProps {
  providers: Provider[];
  riskScores?: Record<string, number>;
}

export function ProviderGrid({ providers, riskScores }: ProviderGridProps) {
  if (providers.length === 0) {
    return (
      <div className="text-center py-12">
        <div className="text-gray-400 text-5xl mb-4">📋</div>
        <h3 className="text-lg font-medium text-gray-900">No providers found</h3>
        <p className="text-gray-500 mt-1">Try adjusting your filters</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {providers.map((provider) => (
        <ProviderCard
          key={provider.id}
          provider={provider}
          riskScore={riskScores?.[provider.id]}
        />
      ))}
    </div>
  );
}
