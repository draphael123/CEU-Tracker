import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import DashboardScreen from './src/screens/DashboardScreen';
import ProvidersScreen from './src/screens/ProvidersScreen';
import ProviderDetailScreen from './src/screens/ProviderDetailScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import { ApiProvider } from './src/hooks/useApi';

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

function ProvidersStack() {
  return (
    <Stack.Navigator>
      <Stack.Screen
        name="ProvidersList"
        component={ProvidersScreen}
        options={{ title: 'Providers' }}
      />
      <Stack.Screen
        name="ProviderDetail"
        component={ProviderDetailScreen}
        options={({ route }) => ({
          title: (route.params as { name?: string })?.name || 'Provider Details',
        })}
      />
    </Stack.Navigator>
  );
}

function TabNavigator() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        tabBarIcon: ({ focused, color, size }) => {
          let iconName: keyof typeof Ionicons.glyphMap = 'home';

          if (route.name === 'Dashboard') {
            iconName = focused ? 'home' : 'home-outline';
          } else if (route.name === 'Providers') {
            iconName = focused ? 'people' : 'people-outline';
          } else if (route.name === 'Settings') {
            iconName = focused ? 'settings' : 'settings-outline';
          }

          return <Ionicons name={iconName} size={size} color={color} />;
        },
        tabBarActiveTintColor: '#1e40af',
        tabBarInactiveTintColor: 'gray',
        headerShown: route.name === 'Dashboard',
      })}
    >
      <Tab.Screen
        name="Dashboard"
        component={DashboardScreen}
        options={{ title: 'CEU Tracker' }}
      />
      <Tab.Screen
        name="Providers"
        component={ProvidersStack}
        options={{ headerShown: false }}
      />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ApiProvider>
        <NavigationContainer>
          <TabNavigator />
          <StatusBar style="auto" />
        </NavigationContainer>
      </ApiProvider>
    </SafeAreaProvider>
  );
}
