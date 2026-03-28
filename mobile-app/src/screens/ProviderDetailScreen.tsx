import React, { useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
} from 'react-native';
import { useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useApi } from '../hooks/useApi';
import ProgressBar from '../components/ProgressBar';

export default function ProviderDetailScreen() {
  const route = useRoute();
  const { name } = route.params as { name: string };
  const { getProvider, loading, refreshData } = useApi();
  const provider = getProvider(name);

  useEffect(() => {
    refreshData();
  }, [refreshData]);

  if (!provider) {
    return (
      <View style={styles.centerContainer}>
        <Ionicons name="person-outline" size={64} color="#9ca3af" />
        <Text style={styles.notFoundText}>Provider not found</Text>
      </View>
    );
  }

  const progress =
    provider.hoursRequired && provider.hoursRequired > 0
      ? ((provider.hoursCompleted || 0) / provider.hoursRequired) * 100
      : 0;

  const statusColor = {
    Complete: '#22c55e',
    'In Progress': '#f59e0b',
    'At Risk': '#ef4444',
    Unknown: '#9ca3af',
  }[provider.status || 'Unknown'];

  return (
    <ScrollView
      style={styles.container}
      refreshControl={
        <RefreshControl refreshing={loading} onRefresh={refreshData} />
      }
    >
      <View style={styles.header}>
        <View style={styles.typeTag}>
          <Text style={styles.typeText}>{provider.type}</Text>
        </View>
        <View style={[styles.statusTag, { backgroundColor: statusColor }]}>
          <Text style={styles.statusText}>{provider.status}</Text>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>CEU Progress</Text>
        <ProgressBar progress={progress} color={statusColor} />
        <View style={styles.progressStats}>
          <View style={styles.stat}>
            <Text style={styles.statValue}>{provider.hoursCompleted || 0}</Text>
            <Text style={styles.statLabel}>Completed</Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statValue}>{provider.hoursRequired || 0}</Text>
            <Text style={styles.statLabel}>Required</Text>
          </View>
          <View style={styles.stat}>
            <Text style={[styles.statValue, { color: statusColor }]}>
              {provider.hoursRemaining || 0}
            </Text>
            <Text style={styles.statLabel}>Remaining</Text>
          </View>
        </View>
      </View>

      {provider.renewalDeadline && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Renewal Deadline</Text>
          <View style={styles.deadlineRow}>
            <Ionicons name="calendar" size={24} color="#1e40af" />
            <Text style={styles.deadlineText}>
              {new Date(provider.renewalDeadline).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
            </Text>
          </View>
        </View>
      )}

      {provider.courses && provider.courses.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Recent Courses</Text>
          {provider.courses.slice(0, 5).map((course, index) => (
            <View key={index} style={styles.courseItem}>
              <View style={styles.courseInfo}>
                <Text style={styles.courseName} numberOfLines={2}>
                  {course.name}
                </Text>
                <Text style={styles.courseDate}>
                  {new Date(course.date).toLocaleDateString()}
                </Text>
              </View>
              <View style={styles.courseHours}>
                <Text style={styles.hoursValue}>{course.hours}</Text>
                <Text style={styles.hoursLabel}>hrs</Text>
              </View>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f3f4f6',
  },
  centerContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  notFoundText: {
    marginTop: 16,
    fontSize: 18,
    color: '#6b7280',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 16,
  },
  typeTag: {
    backgroundColor: '#e5e7eb',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  typeText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
  },
  statusTag: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  statusText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#ffffff',
  },
  card: {
    backgroundColor: '#ffffff',
    marginHorizontal: 16,
    marginBottom: 16,
    padding: 16,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 2,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1f2937',
    marginBottom: 12,
  },
  progressStats: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginTop: 16,
  },
  stat: {
    alignItems: 'center',
  },
  statValue: {
    fontSize: 24,
    fontWeight: '700',
    color: '#1f2937',
  },
  statLabel: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 4,
  },
  deadlineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  deadlineText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1f2937',
  },
  courseItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  courseInfo: {
    flex: 1,
    marginRight: 12,
  },
  courseName: {
    fontSize: 14,
    fontWeight: '500',
    color: '#1f2937',
  },
  courseDate: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 4,
  },
  courseHours: {
    alignItems: 'center',
  },
  hoursValue: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1e40af',
  },
  hoursLabel: {
    fontSize: 10,
    color: '#6b7280',
  },
});
