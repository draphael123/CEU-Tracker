import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import ProgressBar from './ProgressBar';

interface Provider {
  name: string;
  type: string;
  hoursRequired?: number;
  hoursCompleted?: number;
  hoursRemaining?: number;
  status?: 'Complete' | 'In Progress' | 'At Risk' | 'Unknown';
  renewalDeadline?: string;
}

interface ProviderCardProps {
  provider: Provider;
  showChevron?: boolean;
}

export default function ProviderCard({ provider, showChevron }: ProviderCardProps) {
  const statusColors = {
    Complete: '#22c55e',
    'In Progress': '#f59e0b',
    'At Risk': '#ef4444',
    Unknown: '#9ca3af',
  };

  const statusColor = statusColors[provider.status || 'Unknown'];

  const progress =
    provider.hoursRequired && provider.hoursRequired > 0
      ? ((provider.hoursCompleted || 0) / provider.hoursRequired) * 100
      : 0;

  const daysUntilDeadline = provider.renewalDeadline
    ? Math.ceil(
        (new Date(provider.renewalDeadline).getTime() - Date.now()) /
          (1000 * 60 * 60 * 24)
      )
    : null;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.nameContainer}>
          <Text style={styles.name} numberOfLines={1}>
            {provider.name}
          </Text>
          <View style={styles.typeTag}>
            <Text style={styles.typeText}>{provider.type}</Text>
          </View>
        </View>
        {showChevron && (
          <Ionicons name="chevron-forward" size={20} color="#9ca3af" />
        )}
      </View>

      <View style={styles.content}>
        <ProgressBar progress={progress} color={statusColor} />

        <View style={styles.stats}>
          <View style={styles.stat}>
            <Text style={styles.statValue}>
              {provider.hoursCompleted || 0}/{provider.hoursRequired || 0}
            </Text>
            <Text style={styles.statLabel}>hours</Text>
          </View>

          <View style={[styles.statusBadge, { backgroundColor: `${statusColor}20` }]}>
            <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
            <Text style={[styles.statusText, { color: statusColor }]}>
              {provider.status}
            </Text>
          </View>

          {daysUntilDeadline !== null && (
            <View style={styles.stat}>
              <Text style={[styles.statValue, daysUntilDeadline <= 60 && styles.urgentText]}>
                {daysUntilDeadline}
              </Text>
              <Text style={styles.statLabel}>days left</Text>
            </View>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 2,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  nameContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  name: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1f2937',
    flex: 1,
  },
  typeTag: {
    backgroundColor: '#e5e7eb',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  typeText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#374151',
  },
  content: {
    gap: 12,
  },
  stats: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  stat: {
    alignItems: 'center',
  },
  statValue: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1f2937',
  },
  statLabel: {
    fontSize: 11,
    color: '#6b7280',
  },
  urgentText: {
    color: '#ef4444',
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    gap: 6,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '600',
  },
});
