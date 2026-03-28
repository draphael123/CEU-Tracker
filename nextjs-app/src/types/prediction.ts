// Prediction and risk assessment type definitions

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type AlertSeverity = 'critical' | 'warning' | 'info';
export type AlertType =
  | 'overdue'
  | 'deadline-imminent'
  | 'pace-insufficient'
  | 'no-activity'
  | 'subject-gap'
  | 'velocity-drop'
  | 'renewal-approaching'
  | 'completion-risk'
  | 'credential-failing';

export interface RiskFactor {
  name: string;
  score: number;
  maxScore: number;
  description: string;
}

export interface RiskAssessment {
  score: number;
  level: RiskLevel;
  factors: RiskFactor[];
  confidence: number;
}

export interface ScenarioResult {
  willComplete: boolean;
  projectedDate: string | null;
  daysNeeded: number;
  hoursPerWeek: number;
}

export interface ComplianceForecast {
  providerId: string;
  providerName: string;
  completionProbability: number;
  projectedCompletionDate: string | null;
  scenarios: {
    optimistic: ScenarioResult;
    realistic: ScenarioResult;
    pessimistic: ScenarioResult;
  };
}

export interface RecommendedAction {
  priority: 'high' | 'medium' | 'low';
  action: string;
  reason: string;
  estimatedImpact: string;
}

export interface ProviderPrediction {
  providerId: string;
  providerName: string;
  riskScore: number;
  riskLevel: RiskLevel;
  riskFactors: RiskFactor[];
  completionProbability: number;
  projectedCompletionDate: string | null;
  daysUntilDeadline: number | null;
  recommendedActions: RecommendedAction[];
  confidence: number;
  lastUpdated: string;
}

export interface Alert {
  id: string;
  providerId: string;
  providerName: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  message: string;
  actionUrl?: string;
  createdAt: string;
  expiresAt?: string;
  acknowledged: boolean;
}

export interface OrganizationMetrics {
  overallRiskScore: number;
  complianceRate: number;
  projectedComplianceRate: number;
  totalProviders: number;
  criticalCount: number;
  warningCount: number;
  onTrackCount: number;
  completeCount: number;
  trendsLast30Days: {
    riskScoreChange: number;
    complianceRateChange: number;
    coursesCompleted: number;
    hoursCompleted: number;
  };
}

export interface VelocityMetrics {
  avgWeeklyHours: number;
  last30DaysHours: number;
  last60DaysHours: number;
  last90DaysHours: number;
  trend: 'accelerating' | 'steady' | 'decelerating' | 'inactive';
  weeklyRates: number[];
}
