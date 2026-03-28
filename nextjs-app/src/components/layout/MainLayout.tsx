'use client';

import { useState, useEffect } from 'react';
import { Header } from './Header';
import { Sidebar } from './Sidebar';

interface MainLayoutProps {
  children: React.ReactNode;
}

export function MainLayout({ children }: MainLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [stats, setStats] = useState<{ complete: number; atRisk: number; total: number } | null>(
    null
  );
  const [lastUpdated, setLastUpdated] = useState<string | undefined>();

  useEffect(() => {
    // Fetch summary stats
    fetch('/api/providers?limit=1')
      .then((res) => res.json())
      .then((data) => {
        if (data.summary) {
          setStats({
            complete: data.summary.complete,
            atRisk: data.summary.atRisk,
            total: data.summary.total,
          });
        }
      })
      .catch(console.error);

    // Fetch last run data
    fetch('/api/providers')
      .then((res) => res.json())
      .then((data) => {
        if (data.data?.[0]?.lastUpdated) {
          setLastUpdated(data.data[0].lastUpdated);
        }
      })
      .catch(console.error);
  }, []);

  return (
    <div className="min-h-screen bg-gray-50">
      <Header
        lastUpdated={lastUpdated}
        onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
      />
      <div className="flex">
        <Sidebar
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          stats={stats || undefined}
        />
        <main className="flex-1 p-4 lg:p-6 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
