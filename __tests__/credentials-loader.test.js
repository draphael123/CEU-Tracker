// Mock fs before requiring the module
jest.mock('fs');

const mockProviders = [
  { name: 'Test Provider 1', type: 'NP', username: 'test1', password: 'pass1' },
  { name: 'Test Provider 2', type: 'RN', username: 'test2', password: 'pass2', platforms: [
    { platform: 'NetCE', username: 'netce1', password: 'netcepass1' }
  ]},
  { name: 'Test Provider 3', type: 'MD', noCredentials: true },
];

describe('credentials-loader', () => {
  let fs;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.CREDENTIALS_JSON;

    // Get the mocked fs module
    fs = require('fs');
    fs.existsSync = jest.fn();
    fs.readFileSync = jest.fn();
  });

  describe('loadCredentials', () => {
    it('should load from CREDENTIALS_JSON env var when set', () => {
      const encoded = Buffer.from(JSON.stringify(mockProviders)).toString('base64');
      process.env.CREDENTIALS_JSON = encoded;

      const { loadCredentials } = require('../credentials-loader');
      const result = loadCredentials();

      expect(result).toEqual(mockProviders);
    });

    it('should load from credentials.json when env var not set', () => {
      fs.existsSync.mockImplementation((filepath) => {
        return filepath.includes('credentials.json');
      });
      fs.readFileSync.mockReturnValue(JSON.stringify(mockProviders));

      const { loadCredentials } = require('../credentials-loader');
      const result = loadCredentials();

      expect(result).toEqual(mockProviders);
    });

    it('should fallback to providers.json when credentials.json not found', () => {
      fs.existsSync.mockImplementation((filepath) => {
        return filepath.includes('providers.json');
      });
      fs.readFileSync.mockReturnValue(JSON.stringify(mockProviders));

      // Suppress console.warn
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      const { loadCredentials } = require('../credentials-loader');
      const result = loadCredentials();

      expect(result).toEqual(mockProviders);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Loading credentials from providers.json'));

      consoleSpy.mockRestore();
    });

    it('should throw error when no credentials source found', () => {
      fs.existsSync.mockReturnValue(false);

      // Suppress console.warn for providers.json fallback message
      jest.spyOn(console, 'warn').mockImplementation();

      const { loadCredentials } = require('../credentials-loader');

      expect(() => loadCredentials()).toThrow('No credentials source found');
    });
  });

  describe('getProvider', () => {
    beforeEach(() => {
      // Set up environment variable to avoid file system lookups
      const encoded = Buffer.from(JSON.stringify(mockProviders)).toString('base64');
      process.env.CREDENTIALS_JSON = encoded;
    });

    it('should find provider by name', () => {
      const { getProvider } = require('../credentials-loader');
      const result = getProvider('Test Provider 1');

      expect(result).toBeDefined();
      expect(result.name).toBe('Test Provider 1');
      expect(result.type).toBe('NP');
    });

    it('should return undefined for non-existent provider', () => {
      const { getProvider } = require('../credentials-loader');
      const result = getProvider('Non Existent');

      expect(result).toBeUndefined();
    });
  });

  describe('getPlatformCredential', () => {
    beforeEach(() => {
      const encoded = Buffer.from(JSON.stringify(mockProviders)).toString('base64');
      process.env.CREDENTIALS_JSON = encoded;
    });

    it('should find platform credential for provider', () => {
      const { getPlatformCredential } = require('../credentials-loader');
      const result = getPlatformCredential('Test Provider 2', 'NetCE');

      expect(result).toBeDefined();
      expect(result.platform).toBe('NetCE');
      expect(result.username).toBe('netce1');
    });

    it('should return null for provider without platforms', () => {
      const { getPlatformCredential } = require('../credentials-loader');
      const result = getPlatformCredential('Test Provider 1', 'NetCE');

      expect(result).toBeNull();
    });

    it('should return undefined for non-existent platform', () => {
      const { getPlatformCredential } = require('../credentials-loader');
      const result = getPlatformCredential('Test Provider 2', 'NonExistent');

      expect(result).toBeUndefined();
    });
  });

  describe('getAllProviders', () => {
    it('should return all providers', () => {
      const encoded = Buffer.from(JSON.stringify(mockProviders)).toString('base64');
      process.env.CREDENTIALS_JSON = encoded;

      const { getAllProviders } = require('../credentials-loader');
      const result = getAllProviders();

      expect(result).toHaveLength(3);
      expect(result[0].name).toBe('Test Provider 1');
    });
  });
});
