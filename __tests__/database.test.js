const path = require('path');
const fs = require('fs');

// Mock better-sqlite3
const mockDb = {
  pragma: jest.fn(),
  exec: jest.fn(),
  prepare: jest.fn(),
  close: jest.fn(),
};

mockDb.prepare.mockReturnValue({
  get: jest.fn(),
  all: jest.fn().mockReturnValue([]),
  run: jest.fn().mockReturnValue({ lastInsertRowid: 1 }),
});

jest.mock('better-sqlite3', () => {
  return jest.fn(() => mockDb);
});

describe('database', () => {
  let database;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.DATABASE_PATH = ':memory:';
    database = require('../database');
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
  });

  describe('initDatabase', () => {
    it('should initialize database with WAL mode', () => {
      database.initDatabase();

      expect(mockDb.pragma).toHaveBeenCalledWith('journal_mode = WAL');
    });

    it('should create all required tables', () => {
      database.initDatabase();

      expect(mockDb.exec).toHaveBeenCalled();
      const execCall = mockDb.exec.mock.calls[0][0];

      expect(execCall).toContain('CREATE TABLE IF NOT EXISTS providers');
      expect(execCall).toContain('CREATE TABLE IF NOT EXISTS compliance_records');
      expect(execCall).toContain('CREATE TABLE IF NOT EXISTS subject_areas');
      expect(execCall).toContain('CREATE TABLE IF NOT EXISTS courses');
      expect(execCall).toContain('CREATE TABLE IF NOT EXISTS platform_results');
      expect(execCall).toContain('CREATE TABLE IF NOT EXISTS credential_health');
      expect(execCall).toContain('CREATE TABLE IF NOT EXISTS run_history');
    });

    it('should create indexes', () => {
      database.initDatabase();

      const execCall = mockDb.exec.mock.calls[0][0];
      expect(execCall).toContain('CREATE INDEX IF NOT EXISTS idx_compliance_provider');
      expect(execCall).toContain('CREATE INDEX IF NOT EXISTS idx_courses_provider');
    });

    it('should only initialize once', () => {
      database.initDatabase();
      database.initDatabase();

      // Should only be called once since db is cached
      expect(mockDb.exec).toHaveBeenCalledTimes(1);
    });
  });

  describe('getOrCreateProvider', () => {
    it('should create new provider when not exists', () => {
      const mockPrepare = jest.fn();
      const mockGet = jest.fn().mockReturnValueOnce(null).mockReturnValueOnce({ id: 1, name: 'Test Provider' });
      const mockRun = jest.fn().mockReturnValue({ lastInsertRowid: 1 });

      mockPrepare.mockReturnValue({ get: mockGet, run: mockRun });
      mockDb.prepare = mockPrepare;

      database.initDatabase();
      const result = database.getOrCreateProvider('Test Provider', 'NP', 'test@test.com', true);

      expect(result).toBeDefined();
    });

    it('should return existing provider when found', () => {
      const existingProvider = { id: 1, name: 'Existing', type: 'RN' };
      const mockGet = jest.fn().mockReturnValue(existingProvider);
      mockDb.prepare.mockReturnValue({ get: mockGet, run: jest.fn() });

      database.initDatabase();
      const result = database.getOrCreateProvider('Existing', 'RN');

      expect(mockGet).toHaveBeenCalled();
    });
  });

  describe('saveComplianceRecord', () => {
    it('should insert compliance record', () => {
      const mockRun = jest.fn().mockReturnValue({ lastInsertRowid: 42 });
      mockDb.prepare.mockReturnValue({ run: mockRun, get: jest.fn() });

      database.initDatabase();
      const recordId = database.saveComplianceRecord(1, {
        state: 'FL',
        licenseType: 'RN',
        renewalDeadline: '2025-12-31',
        hoursRequired: 24,
        hoursCompleted: 10,
        hoursRemaining: 14,
      });

      expect(recordId).toBe(42);
    });

    it('should save subject areas when provided', () => {
      const mockRun = jest.fn().mockReturnValue({ lastInsertRowid: 42 });
      mockDb.prepare.mockReturnValue({ run: mockRun, get: jest.fn() });

      database.initDatabase();
      database.saveComplianceRecord(1, {
        state: 'FL',
        licenseType: 'RN',
        renewalDeadline: '2025-12-31',
        hoursRequired: 24,
        hoursCompleted: 10,
        hoursRemaining: 14,
        subjectAreas: [
          { subject: 'Pharmacology', hoursRequired: 5, hoursCompleted: 2 },
          { subject: 'Ethics', hoursRequired: 3, hoursCompleted: 1 },
        ],
      });

      // Should have been called for main record + 2 subject areas
      expect(mockRun).toHaveBeenCalled();
    });
  });

  describe('saveCourse', () => {
    it('should insert course record', () => {
      const mockRun = jest.fn();
      mockDb.prepare.mockReturnValue({ run: mockRun, get: jest.fn() });

      database.initDatabase();
      const result = database.saveCourse(1, {
        platform: 'NetCE',
        name: 'Test Course',
        hours: 5,
        date: '2025-01-15',
        category: 'Pharmacology',
      });

      expect(result).toBe(true);
    });

    it('should return false for duplicate course', () => {
      const mockRun = jest.fn().mockImplementation(() => {
        throw new Error('UNIQUE constraint failed');
      });
      mockDb.prepare.mockReturnValue({ run: mockRun, get: jest.fn() });

      database.initDatabase();
      const result = database.saveCourse(1, {
        name: 'Duplicate Course',
        date: '2025-01-15',
      });

      expect(result).toBe(false);
    });
  });

  describe('updateCredentialHealth', () => {
    it('should create new record when not exists', () => {
      const mockGet = jest.fn().mockReturnValue(null);
      const mockRun = jest.fn();
      mockDb.prepare.mockReturnValue({ get: mockGet, run: mockRun });

      database.initDatabase();
      database.updateCredentialHealth(1, 'CE Broker', true);

      expect(mockRun).toHaveBeenCalled();
    });

    it('should update status on failure', () => {
      const mockGet = jest.fn().mockReturnValue({
        consecutive_failures: 2,
        status: 'degraded'
      });
      const mockRun = jest.fn();
      mockDb.prepare.mockReturnValue({ get: mockGet, run: mockRun });

      database.initDatabase();
      database.updateCredentialHealth(1, 'CE Broker', false, 'Login failed');

      expect(mockRun).toHaveBeenCalled();
    });
  });

  describe('getLatestComplianceStatus', () => {
    it('should return all providers with latest compliance', () => {
      const mockAll = jest.fn().mockReturnValue([
        { id: 1, name: 'Provider 1', hours_remaining: 10 },
        { id: 2, name: 'Provider 2', hours_remaining: 5 },
      ]);
      mockDb.prepare.mockReturnValue({ all: mockAll, get: jest.fn() });

      database.initDatabase();
      const result = database.getLatestComplianceStatus();

      expect(result).toHaveLength(2);
    });
  });

  describe('startRun and completeRun', () => {
    it('should create and complete a run', () => {
      const mockRun = jest.fn().mockReturnValue({ lastInsertRowid: 99 });
      mockDb.prepare.mockReturnValue({ run: mockRun, get: jest.fn() });

      database.initDatabase();
      const runId = database.startRun();

      expect(runId).toBe(99);

      database.completeRun(runId, [
        { status: 'success' },
        { status: 'success' },
        { status: 'failed' },
      ]);

      expect(mockRun).toHaveBeenCalled();
    });
  });

  describe('closeDatabase', () => {
    it('should close the database connection', () => {
      database.initDatabase();
      database.closeDatabase();

      expect(mockDb.close).toHaveBeenCalled();
    });
  });
});
