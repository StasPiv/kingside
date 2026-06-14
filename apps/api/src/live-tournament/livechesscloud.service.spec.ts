import { LivechesscloudService } from './livechesscloud.service';

describe('LivechesscloudService', () => {
  let service: LivechesscloudService;

  beforeEach(() => {
    service = new LivechesscloudService();
  });

  describe('getTournamentInfo (with mock fetch)', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('should return isLive=true when rounds have live games', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          name: 'Test Tournament',
          location: 'Test City',
          country: 'US',
          timecontrol: '90+30',
          rounds: [
            { count: 8, live: 2 },
            { count: 0, live: 0 },
          ],
        }),
      }) as any;

      const info = await service.getTournamentInfo('test-uuid');
      expect(info).not.toBeNull();
      expect(info!.isLive).toBe(true);
      expect(info!.totalRounds).toBe(2);
      expect(info!.location).toBe('Test City');
    });

    it('should return isLive=false when no rounds have live games', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          name: 'Archived Tournament',
          rounds: [
            { count: 8, live: 0 },
            { count: 8, live: 0 },
          ],
        }),
      }) as any;

      const info = await service.getTournamentInfo('test-uuid');
      expect(info!.isLive).toBe(false);
    });

    it('should return null on HTTP error', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as any;

      const info = await service.getTournamentInfo('bad-uuid');
      expect(info).toBeNull();
    });

    it('should return null on fetch error', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Network error')) as any;

      const info = await service.getTournamentInfo('bad-uuid');
      expect(info).toBeNull();
    });
  });

  describe('getStatus', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('should return live when tournament has live games', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ rounds: [{ count: 5, live: 3 }] }),
      }) as any;

      expect(await service.getStatus('uuid')).toBe('live');
    });

    it('should return archived when no live games', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ rounds: [{ count: 5, live: 0 }] }),
      }) as any;

      expect(await service.getStatus('uuid')).toBe('archived');
    });

    it('should return unknown on error', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('fail')) as any;

      expect(await service.getStatus('uuid')).toBe('unknown');
    });
  });
});
