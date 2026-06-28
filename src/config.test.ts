import { loadConfig } from './config.js';

describe('loadConfig — hardening flags', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.GITLAB_TOKEN;
    delete process.env.GITLAB_READ_TOKEN;
    delete process.env.GITLAB_PIN_HOST;
    delete process.env.GITLAB_ALLOW_SHARED_ESCAPE_HATCH;
    delete process.env.GITLAB_URL;
  });
  afterAll(() => {
    process.env = saved;
  });

  it('pins the host and disables shared escape-hatch by default', () => {
    const c = loadConfig();
    expect(c.pinHost).toBe(true);
    expect(c.allowSharedEscapeHatch).toBe(false);
  });

  it('honors GITLAB_PIN_HOST=false', () => {
    process.env.GITLAB_PIN_HOST = 'false';
    expect(loadConfig().pinHost).toBe(false);
  });

  it('honors GITLAB_ALLOW_SHARED_ESCAPE_HATCH truthy values', () => {
    for (const v of ['true', '1', 'yes', 'on']) {
      process.env.GITLAB_ALLOW_SHARED_ESCAPE_HATCH = v;
      expect(loadConfig().allowSharedEscapeHatch).toBe(true);
    }
  });

  it('treats unknown values as the default (not a crash)', () => {
    process.env.GITLAB_PIN_HOST = 'maybe';
    expect(loadConfig().pinHost).toBe(true);
  });

  it('rejects GITLAB_TOKEN and GITLAB_READ_TOKEN set together', () => {
    process.env.GITLAB_TOKEN = 'a';
    process.env.GITLAB_READ_TOKEN = 'b';
    expect(() => loadConfig()).toThrow(/mutually exclusive/);
  });
});
