// Mock Sentry before requiring the module
const mockSentry = {
  init: jest.fn(),
  withScope: jest.fn((callback) => callback({
    setTag: jest.fn(),
    setLevel: jest.fn(),
    setExtras: jest.fn(),
  })),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  startTransaction: jest.fn().mockReturnValue({ finish: jest.fn() }),
  flush: jest.fn().mockResolvedValue(true),
};

jest.mock('@sentry/node', () => mockSentry);

describe('sentry', () => {
  let sentry;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.SENTRY_DSN;
    delete process.env.NODE_ENV;
  });

  describe('initSentry', () => {
    it('should not initialize without SENTRY_DSN', () => {
      sentry = require('../sentry');
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      sentry.initSentry();

      expect(mockSentry.init).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No SENTRY_DSN configured'));

      consoleSpy.mockRestore();
    });

    it('should initialize with SENTRY_DSN', () => {
      process.env.SENTRY_DSN = 'https://test@sentry.io/123';
      sentry = require('../sentry');
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      sentry.initSentry();

      expect(mockSentry.init).toHaveBeenCalledWith(expect.objectContaining({
        dsn: 'https://test@sentry.io/123',
        tracesSampleRate: 0.1,
      }));

      consoleSpy.mockRestore();
    });

    it('should use NODE_ENV for environment', () => {
      process.env.SENTRY_DSN = 'https://test@sentry.io/123';
      process.env.NODE_ENV = 'production';
      sentry = require('../sentry');

      sentry.initSentry();

      expect(mockSentry.init).toHaveBeenCalledWith(expect.objectContaining({
        environment: 'production',
      }));
    });

    it('should default to development environment', () => {
      process.env.SENTRY_DSN = 'https://test@sentry.io/123';
      sentry = require('../sentry');

      sentry.initSentry();

      expect(mockSentry.init).toHaveBeenCalledWith(expect.objectContaining({
        environment: 'development',
      }));
    });

    it('should only initialize once', () => {
      process.env.SENTRY_DSN = 'https://test@sentry.io/123';
      sentry = require('../sentry');

      sentry.initSentry();
      sentry.initSentry();

      expect(mockSentry.init).toHaveBeenCalledTimes(1);
    });
  });

  describe('captureError', () => {
    it('should not capture when not initialized', () => {
      sentry = require('../sentry');
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      sentry.captureError(new Error('Test error'));

      expect(mockSentry.captureException).not.toHaveBeenCalled();
      // console.error is called with two arguments: the message and error.message
      expect(consoleSpy).toHaveBeenCalled();
      expect(consoleSpy.mock.calls[0][0]).toContain('Not initialized');

      consoleSpy.mockRestore();
    });

    it('should capture error with context when initialized', () => {
      process.env.SENTRY_DSN = 'https://test@sentry.io/123';
      sentry = require('../sentry');
      jest.spyOn(console, 'log').mockImplementation();

      sentry.initSentry();
      const error = new Error('Test error');
      sentry.captureError(error, { provider: 'TestProvider', platform: 'CE Broker' });

      expect(mockSentry.withScope).toHaveBeenCalled();
      expect(mockSentry.captureException).toHaveBeenCalledWith(error);
    });
  });

  describe('captureMessage', () => {
    it('should not capture when not initialized', () => {
      sentry = require('../sentry');

      sentry.captureMessage('Test message');

      expect(mockSentry.captureMessage).not.toHaveBeenCalled();
    });

    it('should capture message when initialized', () => {
      process.env.SENTRY_DSN = 'https://test@sentry.io/123';
      sentry = require('../sentry');
      jest.spyOn(console, 'log').mockImplementation();

      sentry.initSentry();
      sentry.captureMessage('Test message', 'warning', { context: 'test' });

      expect(mockSentry.withScope).toHaveBeenCalled();
      expect(mockSentry.captureMessage).toHaveBeenCalledWith('Test message');
    });
  });

  describe('setUser', () => {
    it('should not set user when not initialized', () => {
      sentry = require('../sentry');

      sentry.setUser({ id: '123', email: 'test@test.com' });

      expect(mockSentry.setUser).not.toHaveBeenCalled();
    });

    it('should set user when initialized', () => {
      process.env.SENTRY_DSN = 'https://test@sentry.io/123';
      sentry = require('../sentry');
      jest.spyOn(console, 'log').mockImplementation();

      sentry.initSentry();
      sentry.setUser({ id: '123', email: 'test@test.com' });

      expect(mockSentry.setUser).toHaveBeenCalledWith({ id: '123', email: 'test@test.com' });
    });
  });

  describe('addBreadcrumb', () => {
    it('should not add breadcrumb when not initialized', () => {
      sentry = require('../sentry');

      sentry.addBreadcrumb('Test breadcrumb', 'scraper', { step: 1 });

      expect(mockSentry.addBreadcrumb).not.toHaveBeenCalled();
    });

    it('should add breadcrumb when initialized', () => {
      process.env.SENTRY_DSN = 'https://test@sentry.io/123';
      sentry = require('../sentry');
      jest.spyOn(console, 'log').mockImplementation();

      sentry.initSentry();
      sentry.addBreadcrumb('Test breadcrumb', 'scraper', { step: 1 });

      expect(mockSentry.addBreadcrumb).toHaveBeenCalledWith({
        message: 'Test breadcrumb',
        category: 'scraper',
        data: { step: 1 },
        level: 'info',
      });
    });
  });

  describe('startTransaction', () => {
    it('should return null when not initialized', () => {
      sentry = require('../sentry');

      const result = sentry.startTransaction('test-transaction');

      expect(result).toBeNull();
      expect(mockSentry.startTransaction).not.toHaveBeenCalled();
    });

    it('should start transaction when initialized', () => {
      process.env.SENTRY_DSN = 'https://test@sentry.io/123';
      sentry = require('../sentry');
      jest.spyOn(console, 'log').mockImplementation();

      sentry.initSentry();
      sentry.startTransaction('test-transaction', 'scrape');

      expect(mockSentry.startTransaction).toHaveBeenCalledWith({
        name: 'test-transaction',
        op: 'scrape',
      });
    });
  });

  describe('flush', () => {
    it('should do nothing when not initialized', async () => {
      sentry = require('../sentry');

      await sentry.flush();

      expect(mockSentry.flush).not.toHaveBeenCalled();
    });

    it('should flush when initialized', async () => {
      process.env.SENTRY_DSN = 'https://test@sentry.io/123';
      sentry = require('../sentry');
      jest.spyOn(console, 'log').mockImplementation();

      sentry.initSentry();
      await sentry.flush(5000);

      expect(mockSentry.flush).toHaveBeenCalledWith(5000);
    });
  });
});
