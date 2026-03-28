import React, { useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useApi } from '../hooks/useApi';
import StatusCard from '../components/StatusCard';
import ProviderCard from '../components/ProviderCard';

export default function DashboardScreen() {
  const { providers, stats, loading, error, refreshData } = useApi();

  useEffect(() => {
    refreshData();
  }, [refreshData]);

  const atRiskProviders = providers.filter((p) => p.status === 'At Risk');

  return (
    <ScrollView
      style={styles.container}
      refreshControl={
        <RefreshControl refreshing={loading} onRefresh={refreshData} />
      }
    >
      {error && (
        <View style={styles.errorBanner}>
          <Ionicons name="warning" size={20} color="#dc2626" />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <View style={styles.statsGrid}>
        <StatusCard
          title="Total Providers"
          value={stats?.totalProviders || 0}
          icon="people"
          color="#3b82f6"
        />
        <StatusCard
          title="Complete"
          value={stats?.complete || 0}
          icon="checkmark-circle"
          color="#22c55e"
        />
        <StatusCard
          title="In Progress"
          value={stats?.inProgress || 0}
          icon="time"
          color="#f59e0b"
        />
        <StatusCard
          title="At Risk"
          value={stats?.atRisk || 0}
          icon="alert-circle"
          color="#ef4444"
        />
      </View>

      {atRiskProviders.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Providers at Risk</Text>
          {atRiskProviders.map((provider) => (
            <ProviderCard key={provider.name} provider={provider} />
          ))}
        </View>
      )}

      {stats?.lastUpdated && (
        <Text style={styles.lastUpdated}>
          Last updated: {new Date(stats.lastUpdated).toLocaleString()}
        </Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f3f4f6',
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fef2f2',
    padding: 12,
    margin: 16,
    borderRadius: 8,
    gap: 8,
  },
  errorText: {
    color: '#dc2626',
    flex: 1,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    padding: 8,
    gap: 8,
  },
  section: {
    padding: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1f2937',
    marginBottom: 12,
  },
  lastUpdated: {
    textAlign: 'center',
    color: '#6b7280',
    fontSize: 12,
    padding: 16,
  },
});
