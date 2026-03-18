import { ChessResultsService } from './chess-results.service';

describe('ChessResultsService', () => {
  let service: ChessResultsService;

  beforeEach(() => {
    service = new ChessResultsService();
  });

  describe('extractLivechessUuids', () => {
    it('should extract UUID from livechesscloud URL with hash', () => {
      const html = `
        <div class="CRmsg">
          Live: view.livechesscloud.com#abcdef01-2345-6789-abcd-ef0123456789
        </div>
      `;
      const uuids = service.extractLivechessUuids(html);
      expect(uuids).toEqual(['abcdef01-2345-6789-abcd-ef0123456789']);
    });

    it('should extract UUID from livechesscloud URL with slash', () => {
      const html = `
        <h2>view.livechesscloud.com/abcdef01-2345-6789-abcd-ef0123456789</h2>
      `;
      const uuids = service.extractLivechessUuids(html);
      expect(uuids).toEqual(['abcdef01-2345-6789-abcd-ef0123456789']);
    });

    it('should extract multiple UUIDs', () => {
      const html = `
        <div>view.livechesscloud.com#11111111-1111-1111-1111-111111111111</div>
        <div>view.livechesscloud.com/22222222-2222-2222-2222-222222222222</div>
      `;
      const uuids = service.extractLivechessUuids(html);
      expect(uuids).toHaveLength(2);
      expect(uuids).toContain('11111111-1111-1111-1111-111111111111');
      expect(uuids).toContain('22222222-2222-2222-2222-222222222222');
    });

    it('should deduplicate identical UUIDs', () => {
      const html = `
        <div>view.livechesscloud.com#abcdef01-2345-6789-abcd-ef0123456789</div>
        <div>view.livechesscloud.com/abcdef01-2345-6789-abcd-ef0123456789</div>
      `;
      const uuids = service.extractLivechessUuids(html);
      expect(uuids).toHaveLength(1);
    });

    it('should return empty array when no UUIDs found', () => {
      const html = '<html><body>No livechess links here</body></html>';
      const uuids = service.extractLivechessUuids(html);
      expect(uuids).toEqual([]);
    });

    it('should handle case-insensitive URLs', () => {
      const html = 'View.LiveChessCloud.com#ABCDEF01-2345-6789-ABCD-EF0123456789';
      const uuids = service.extractLivechessUuids(html);
      expect(uuids).toEqual(['abcdef01-2345-6789-abcd-ef0123456789']);
    });
  });

  describe('extractTournamentName', () => {
    it('should extract name from title tag', () => {
      const html = '<title>Chess-Results Server Chess-results.com - 18.SOMBOR OPEN</title>';
      const name = service.extractTournamentName(html);
      expect(name).toBe('18.SOMBOR OPEN');
    });

    it('should handle title without dash separator', () => {
      const html = '<title>Some Tournament</title>';
      const name = service.extractTournamentName(html);
      expect(name).toBe('Some Tournament');
    });

    it('should return Unknown Tournament when no title', () => {
      const html = '<html><body>No title</body></html>';
      const name = service.extractTournamentName(html);
      expect(name).toBe('Unknown Tournament');
    });
  });
});
