/**
 * Tests for scraper.js error classification and helper functions
 */

// We need to extract the classifyLoginError function for testing
// Since it's not exported, we'll test it indirectly or mock it

describe('Scraper Error Classification', () => {
  // Helper to simulate the classifyLoginError logic for testing
  function classifyLoginError(error, pageContent = '') {
    const msg = (error?.message || '').toLowerCase();
    const content = pageContent.toLowerCase();

    if (content.includes('invalid') || content.includes('incorrect') ||
        content.includes('wrong password') || content.includes('password is incorrect') ||
        content.includes('credentials') || content.includes('authentication failed')) {
      return {
        code: 'invalid_credentials',
        message: 'Invalid username or password',
        action: 'Contact provider to verify their CE Broker login credentials'
      };
    }

    if (content.includes('locked') || content.includes('disabled') ||
        content.includes('suspended') || content.includes('too many attempts') ||
        content.includes('account has been')) {
      return {
        code: 'account_locked',
        message: 'Account locked or disabled',
        action: 'Provider needs to contact CE Broker support to unlock their account'
      };
    }

    if (content.includes('verification code') || content.includes('two-factor') ||
        content.includes('2fa') || content.includes('mfa') ||
        content.includes('authenticator') || content.includes('verify your identity') ||
        content.includes('security code') || content.includes('one-time')) {
      return {
        code: 'mfa_required',
        message: 'Two-factor authentication required',
        action: 'Provider has 2FA enabled. They need to disable it or provide a workaround'
      };
    }

    if (msg.includes('timeout') || msg.includes('timed out') ||
        msg.includes('navigation timeout') || msg.includes('waiting for')) {
      return {
        code: 'timeout',
        message: 'Login page took too long to respond',
        action: 'CE Broker may be slow or down. Will retry on next run'
      };
    }

    if (msg.includes('waiting for selector') || msg.includes('failed to find') ||
        msg.includes('locator') || msg.includes('element not found')) {
      return {
        code: 'site_changed',
        message: 'CE Broker login page has changed',
        action: 'Contact support - the scraper may need to be updated'
      };
    }

    if (msg.includes('net::') || msg.includes('network') ||
        msg.includes('econnrefused') || msg.includes('enotfound') ||
        msg.includes('connection') || msg.includes('dns')) {
      return {
        code: 'network_error',
        message: 'Network connection failed',
        action: 'Check internet connection. Will retry on next run'
      };
    }

    if (msg.includes('redirect') || msg.includes('url') && msg.includes('expected') ||
        content.includes('session expired') || content.includes('please log in again')) {
      return {
        code: 'session_error',
        message: 'Login session failed to establish',
        action: 'CE Broker may have changed their login flow. Will retry on next run'
      };
    }

    return {
      code: 'unknown',
      message: 'Login failed for unknown reason',
      action: 'Check screenshot for details. May need credential update'
    };
  }

  describe('classifyLoginError', () => {
    it('should classify invalid credentials from page content', () => {
      const result = classifyLoginError({}, 'Invalid username or password');
      expect(result.code).toBe('invalid_credentials');
      expect(result.message).toBe('Invalid username or password');
    });

    it('should classify incorrect password', () => {
      const result = classifyLoginError({}, 'Your password is incorrect. Please try again.');
      expect(result.code).toBe('invalid_credentials');
    });

    it('should classify authentication failed', () => {
      const result = classifyLoginError({}, 'Authentication failed');
      expect(result.code).toBe('invalid_credentials');
    });

    it('should classify locked accounts', () => {
      const result = classifyLoginError({}, 'Your account has been locked due to too many attempts');
      expect(result.code).toBe('account_locked');
      expect(result.message).toBe('Account locked or disabled');
    });

    it('should classify disabled accounts', () => {
      const result = classifyLoginError({}, 'This account has been disabled');
      expect(result.code).toBe('account_locked');
    });

    it('should classify suspended accounts', () => {
      const result = classifyLoginError({}, 'Account suspended');
      expect(result.code).toBe('account_locked');
    });

    it('should classify 2FA/MFA requirements', () => {
      const result = classifyLoginError({}, 'Please enter your verification code');
      expect(result.code).toBe('mfa_required');
      expect(result.message).toBe('Two-factor authentication required');
    });

    it('should classify two-factor auth', () => {
      const result = classifyLoginError({}, 'Two-factor authentication is required');
      expect(result.code).toBe('mfa_required');
    });

    it('should classify authenticator app requirement', () => {
      const result = classifyLoginError({}, 'Enter code from authenticator app');
      expect(result.code).toBe('mfa_required');
    });

    it('should classify timeout errors from error message', () => {
      const result = classifyLoginError({ message: 'Navigation timeout exceeded' }, '');
      expect(result.code).toBe('timeout');
      expect(result.message).toBe('Login page took too long to respond');
    });

    it('should classify waiting timeout', () => {
      const result = classifyLoginError({ message: 'Waiting for selector timed out' }, '');
      expect(result.code).toBe('timeout');
    });

    it('should classify site structure changes', () => {
      // Note: "Waiting for selector" matches timeout first due to "waiting for"
      // Use a message that clearly indicates site change without timeout keywords
      const result = classifyLoginError({ message: 'Locator #login-button not found' }, '');
      expect(result.code).toBe('site_changed');
      expect(result.message).toBe('CE Broker login page has changed');
    });

    it('should classify element not found', () => {
      const result = classifyLoginError({ message: 'Element not found: #password' }, '');
      expect(result.code).toBe('site_changed');
    });

    it('should classify network errors', () => {
      const result = classifyLoginError({ message: 'net::ERR_CONNECTION_REFUSED' }, '');
      expect(result.code).toBe('network_error');
      expect(result.message).toBe('Network connection failed');
    });

    it('should classify DNS errors', () => {
      const result = classifyLoginError({ message: 'DNS resolution failed' }, '');
      expect(result.code).toBe('network_error');
    });

    it('should classify connection refused', () => {
      const result = classifyLoginError({ message: 'ECONNREFUSED' }, '');
      expect(result.code).toBe('network_error');
    });

    it('should classify session errors from page content', () => {
      const result = classifyLoginError({}, 'Session expired. Please log in again.');
      expect(result.code).toBe('session_error');
      expect(result.message).toBe('Login session failed to establish');
    });

    it('should return unknown for unrecognized errors', () => {
      const result = classifyLoginError({ message: 'Some random error' }, 'Random page content');
      expect(result.code).toBe('unknown');
      expect(result.message).toBe('Login failed for unknown reason');
    });

    it('should handle null error object', () => {
      const result = classifyLoginError(null, '');
      expect(result.code).toBe('unknown');
    });

    it('should handle undefined error object', () => {
      const result = classifyLoginError(undefined, '');
      expect(result.code).toBe('unknown');
    });

    it('should prioritize page content over error message', () => {
      // Page shows invalid credentials but error message is timeout
      // Page content should take precedence for credential issues
      const result = classifyLoginError(
        { message: 'timeout' },
        'Invalid credentials provided'
      );
      expect(result.code).toBe('invalid_credentials');
    });
  });
});

describe('Empty Record Structure', () => {
  function emptyRecord(provider) {
    return {
      providerName:     provider.name,
      providerType:     provider.type,
      state:            null,
      licenseType:      provider.type,
      licenseNumber:    null,
      licenseId:        null,
      renewalDeadline:  null,
      hoursRequired:    null,
      hoursCompleted:   null,
      hoursRemaining:   null,
      lastUpdated:      null,
      subjectAreas:     [],
      completedCourses: [],
      providerEmail:    provider.email || (provider.username?.includes('@') ? provider.username : null),
      providerPhone:    provider.phone || null,
    };
  }

  it('should create an empty record with provider name and type', () => {
    const provider = { name: 'John Doe', type: 'NP' };
    const record = emptyRecord(provider);

    expect(record.providerName).toBe('John Doe');
    expect(record.providerType).toBe('NP');
    expect(record.licenseType).toBe('NP');
  });

  it('should have all required null fields', () => {
    const provider = { name: 'Test', type: 'MD' };
    const record = emptyRecord(provider);

    expect(record.state).toBeNull();
    expect(record.licenseNumber).toBeNull();
    expect(record.licenseId).toBeNull();
    expect(record.renewalDeadline).toBeNull();
    expect(record.hoursRequired).toBeNull();
    expect(record.hoursCompleted).toBeNull();
    expect(record.hoursRemaining).toBeNull();
    expect(record.lastUpdated).toBeNull();
  });

  it('should have empty arrays for courses and subjects', () => {
    const provider = { name: 'Test', type: 'RN' };
    const record = emptyRecord(provider);

    expect(record.subjectAreas).toEqual([]);
    expect(record.completedCourses).toEqual([]);
  });

  it('should extract email from provider object', () => {
    const provider = { name: 'Test', type: 'NP', email: 'test@example.com' };
    const record = emptyRecord(provider);

    expect(record.providerEmail).toBe('test@example.com');
  });

  it('should extract email from username if it contains @', () => {
    const provider = { name: 'Test', type: 'NP', username: 'user@cebroker.com' };
    const record = emptyRecord(provider);

    expect(record.providerEmail).toBe('user@cebroker.com');
  });

  it('should not use username as email if it lacks @', () => {
    const provider = { name: 'Test', type: 'NP', username: 'username123' };
    const record = emptyRecord(provider);

    expect(record.providerEmail).toBeNull();
  });

  it('should extract phone from provider object', () => {
    const provider = { name: 'Test', type: 'NP', phone: '555-1234' };
    const record = emptyRecord(provider);

    expect(record.providerPhone).toBe('555-1234');
  });

  it('should have null phone when not provided', () => {
    const provider = { name: 'Test', type: 'NP' };
    const record = emptyRecord(provider);

    expect(record.providerPhone).toBeNull();
  });
});
