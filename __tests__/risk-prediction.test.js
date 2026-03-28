const { calculateRisk, analyzeAll, getSummaryStats, RiskPredictor } = require('../risk-prediction');

describe('risk-prediction', () => {
  describe('calculateRisk', () => {
    it('should return high risk for provider with approaching deadline', () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 30);

      const provider = {
        name: 'Test Provider',
        renewalDeadline: futureDate.toISOString(),
        hoursRemaining: 15,
        hoursRequired: 20,
      };

      const result = calculateRisk(provider);

      expect(result.score).toBeGreaterThan(0.5);
      expect(['critical', 'high', 'medium']).toContain(result.level);
      expect(result.percentage).toBeGreaterThan(50);
    });

    it('should return low risk for completed provider', () => {
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);

      const provider = {
        name: 'Completed Provider',
        renewalDeadline: futureDate.toISOString(),
        hoursRemaining: 0,
        hoursRequired: 20,
      };

      const result = calculateRisk(provider);

      expect(result.score).toBeLessThan(0.5);
      expect(['low', 'minimal']).toContain(result.level);
    });

    it('should include factors breakdown', () => {
      const provider = {
        name: 'Test Provider',
        renewalDeadline: new Date().toISOString(),
        hoursRemaining: 10,
        hoursRequired: 20,
      };

      const result = calculateRisk(provider);

      expect(result.factors).toBeDefined();
      expect(result.factors.daysToDeadline).toBeDefined();
      expect(result.factors.hoursRemaining).toBeDefined();
      expect(result.factors.completionRate).toBeDefined();
      expect(result.factors.courseFrequency).toBeDefined();
      expect(result.factors.lastActivity).toBeDefined();
    });

    it('should generate recommendations for high-risk providers', () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 10);

      const provider = {
        name: 'At Risk Provider',
        renewalDeadline: pastDate.toISOString(),
        hoursRemaining: 20,
        hoursRequired: 20,
      };

      const result = calculateRisk(provider);

      expect(result.recommendations).toBeDefined();
      expect(result.recommendations.length).toBeGreaterThan(0);
      expect(result.recommendations[0]).toHaveProperty('priority');
      expect(result.recommendations[0]).toHaveProperty('message');
      expect(result.recommendations[0]).toHaveProperty('action');
    });

    it('should include predicted completion likelihood', () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 90);

      const provider = {
        name: 'Test Provider',
        renewalDeadline: futureDate.toISOString(),
        hoursRemaining: 10,
        hoursRequired: 20,
      };

      const result = calculateRisk(provider);

      expect(result.predictedCompletion).toBeDefined();
      expect(result.predictedCompletion.confidence).toBeDefined();
    });

    it('should factor in historical course data', () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 60);

      const provider = {
        name: 'Active Provider',
        renewalDeadline: futureDate.toISOString(),
        hoursRemaining: 5,
        hoursRequired: 20,
      };

      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 7);

      const history = {
        courses: [
          { name: 'Course 1', hours: 5, date: recentDate.toISOString() },
          { name: 'Course 2', hours: 5, date: new Date(recentDate - 30 * 24 * 60 * 60 * 1000).toISOString() },
          { name: 'Course 3', hours: 5, date: new Date(recentDate - 60 * 24 * 60 * 60 * 1000).toISOString() },
        ],
        lastCourseDate: recentDate.toISOString(),
      };

      const resultWithHistory = calculateRisk(provider, history);
      const resultWithoutHistory = calculateRisk(provider);

      // Provider with good history should have lower risk
      expect(resultWithHistory.score).toBeLessThan(resultWithoutHistory.score);
    });
  });

  describe('RiskPredictor class', () => {
    let predictor;

    beforeEach(() => {
      predictor = new RiskPredictor();
    });

    it('should calculate deadline factor correctly', () => {
      // Past deadline
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 10);
      expect(predictor.calculateDeadlineFactor(pastDate.toISOString())).toBe(1.0);

      // Within 30 days
      const soon = new Date();
      soon.setDate(soon.getDate() + 20);
      expect(predictor.calculateDeadlineFactor(soon.toISOString())).toBe(0.9);

      // Far future
      const farFuture = new Date();
      farFuture.setFullYear(farFuture.getFullYear() + 1);
      expect(predictor.calculateDeadlineFactor(farFuture.toISOString())).toBe(0.1);
    });

    it('should calculate hours factor correctly', () => {
      // No hours remaining
      expect(predictor.calculateHoursFactor(0, 20)).toBe(0);

      // All hours remaining
      expect(predictor.calculateHoursFactor(20, 20)).toBe(1.0);

      // Half remaining
      expect(predictor.calculateHoursFactor(10, 20)).toBe(0.6);
    });

    it('should return correct risk levels', () => {
      expect(predictor.getRiskLevel(0.9)).toBe('critical');
      expect(predictor.getRiskLevel(0.7)).toBe('high');
      expect(predictor.getRiskLevel(0.5)).toBe('medium');
      expect(predictor.getRiskLevel(0.3)).toBe('low');
      expect(predictor.getRiskLevel(0.1)).toBe('minimal');
    });
  });

  describe('analyzeAll', () => {
    it('should analyze multiple providers', () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 90);

      const providers = [
        { name: 'Provider 1', type: 'NP', hoursRemaining: 0, hoursRequired: 20, renewalDeadline: futureDate.toISOString() },
        { name: 'Provider 2', type: 'RN', hoursRemaining: 15, hoursRequired: 20, renewalDeadline: futureDate.toISOString() },
        { name: 'Provider 3', type: 'MD', hoursRemaining: 20, hoursRequired: 20, renewalDeadline: new Date().toISOString() },
      ];

      const results = analyzeAll(providers);

      expect(results).toHaveLength(3);
      expect(results[0].name).toBe('Provider 1');
      expect(results[0].score).toBeDefined();
      expect(results[0].level).toBeDefined();
    });
  });

  describe('getSummaryStats', () => {
    it('should generate summary statistics', () => {
      const predictions = [
        { name: 'P1', score: 0.9, level: 'critical', recommendations: [{ category: 'deadline', priority: 'high' }] },
        { name: 'P2', score: 0.6, level: 'high', recommendations: [{ category: 'deadline', priority: 'high' }] },
        { name: 'P3', score: 0.3, level: 'low', recommendations: [{ category: 'pace', priority: 'medium' }] },
        { name: 'P4', score: 0.1, level: 'minimal', recommendations: [] },
      ];

      const stats = getSummaryStats(predictions);

      expect(stats.total).toBe(4);
      expect(stats.byLevel.critical).toBe(1);
      expect(stats.byLevel.high).toBe(1);
      expect(stats.byLevel.low).toBe(1);
      expect(stats.byLevel.minimal).toBe(1);
      expect(stats.highestRisk.name).toBe('P1');
      expect(stats.averageRisk).toBeCloseTo(0.475, 1);
    });
  });
});
