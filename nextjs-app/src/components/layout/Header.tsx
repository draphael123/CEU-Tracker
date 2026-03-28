'use client';

import { useState } from 'react';
import Link from 'next/link';

interface HeaderProps {
  lastUpdated?: string;
  onToggleSidebar?: () => void;
}

export function Header({ lastUpdated, onToggleSidebar }: HeaderProps) {
  const [searchQuery, setSearchQuery] = useState('');

  const getRelativeTime = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${diffDays}d ago`;
  };

  return (
    <header className="sticky top-0 z-50 bg-gradient-to-r from-indigo-600 to-purple-600 text-white shadow-lg">
      <div className="px-4 py-3">
        <div className="flex items-center justify-between gap-4">
          {/* Left: Logo and title */}
          <div className="flex items-center gap-3">
            <button
              onClick={onToggleSidebar}
              className="lg:hidden p-2 hover:bg-white/10 rounded-lg transition-colors"
              aria-label="Toggle sidebar"
            >
              <svg
                className="w-6 h-6"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 6h16M4 12h16M4 18h16"
                />
              </svg>
            </button>
            <Link href="/" className="flex items-center gap-2">
              <div className="w-8 h-8 bg-white/20 rounded-lg flex items-center justify-center">
                <span className="text-lg font-bold">CE</span>
              </div>
              <div>
                <h1 className="text-lg font-semibold">CEU Tracker</h1>
                <p className="text-xs text-white/70">Compliance Dashboard</p>
              </div>
            </Link>
          </div>

          {/* Center: Search */}
          <div className="hidden md:flex flex-1 max-w-md">
            <div className="relative w-full">
              <input
                type="text"
                placeholder="Search providers..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full px-4 py-2 pl-10 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/50 focus:outline-none focus:ring-2 focus:ring-white/30 focus:bg-white/15"
              />
              <svg
                className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/50"
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
          </div>

          {/* Right: Status and actions */}
          <div className="flex items-center gap-4">
            {lastUpdated && (
              <div className="hidden sm:flex items-center gap-2 text-sm text-white/70">
                <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
                <span>Updated {getRelativeTime(lastUpdated)}</span>
              </div>
            )}
            <button
              className="p-2 hover:bg-white/10 rounded-lg transition-colors"
              aria-label="Toggle theme"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
                />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
