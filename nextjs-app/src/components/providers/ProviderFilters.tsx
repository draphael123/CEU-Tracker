'use client';

import { useSearchParams, useRouter } from 'next/navigation';
import type { ProviderStatus, Provider } from '@/types';

interface ProviderFiltersProps {
  states: string[];
  types: Provider['type'][];
  totalCount?: number;
  filteredCount?: number;
}

const statusOptions: { value: ProviderStatus | 'all'; label: string; color: string }[] = [
  { value: 'all', label: 'All', color: 'bg-gray-100 text-gray-700' },
  { value: 'Complete', label: 'Complete', color: 'bg-green-100 text-green-700' },
  { value: 'In Progress', label: 'In Progress', color: 'bg-amber-100 text-amber-700' },
  { value: 'At Risk', label: 'At Risk', color: 'bg-red-100 text-red-700' },
];

export function ProviderFilters({
  states,
  types,
  totalCount,
  filteredCount,
}: ProviderFiltersProps) {
  const searchParams = useSearchParams();
  const router = useRouter();

  const currentStatus = searchParams.get('status') || 'all';
  const currentState = searchParams.get('state') || 'all';
  const currentType = searchParams.get('type') || 'all';
  const currentSearch = searchParams.get('q') || '';

  const updateFilter = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value === 'all' || value === '') {
      params.delete(key);
    } else {
      params.set(key, value);
    }
    router.push(`?${params.toString()}`);
  };

  const clearFilters = () => {
    router.push('?');
  };

  const hasFilters =
    currentStatus !== 'all' || currentState !== 'all' || currentType !== 'all' || currentSearch;

  return (
    <div className="space-y-4">
      {/* Status filter chips */}
      <div className="flex flex-wrap gap-2">
        {statusOptions.map((option) => (
          <button
            key={option.value}
            onClick={() => updateFilter('status', option.value)}
            className={`
              px-3 py-1.5 rounded-full text-sm font-medium transition-all
              ${
                currentStatus === option.value
                  ? `${option.color} ring-2 ring-offset-1 ring-current`
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }
            `}
          >
            {option.label}
          </button>
        ))}
      </div>

      {/* Dropdowns and search */}
      <div className="flex flex-wrap gap-3">
        {/* State dropdown */}
        <select
          value={currentState}
          onChange={(e) => updateFilter('state', e.target.value)}
          className="px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="all">All States</option>
          {states.map((state) => (
            <option key={state} value={state}>
              {state}
            </option>
          ))}
        </select>

        {/* Type dropdown */}
        <select
          value={currentType}
          onChange={(e) => updateFilter('type', e.target.value)}
          className="px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="all">All Types</option>
          {types.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>

        {/* Search input */}
        <div className="relative flex-1 min-w-[200px]">
          <input
            type="text"
            placeholder="Search providers..."
            value={currentSearch}
            onChange={(e) => updateFilter('q', e.target.value)}
            className="w-full px-3 py-2 pl-9 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        </div>

        {/* Clear filters */}
        {hasFilters && (
          <button
            onClick={clearFilters}
            className="px-3 py-2 text-sm text-gray-600 hover:text-gray-900"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Results count */}
      {totalCount !== undefined && (
        <div className="text-sm text-gray-500">
          {filteredCount !== undefined && filteredCount !== totalCount ? (
            <>
              Showing {filteredCount} of {totalCount} providers
            </>
          ) : (
            <>{totalCount} providers</>
          )}
        </div>
      )}
    </div>
  );
}
