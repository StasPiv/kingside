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

  describe('extractMetadata', () => {
    it('should extract description from CRmsg', () => {
      const html = '<h3 Class="CRmsg">Tournament starts on Monday<br/>Contact: admin@test.com</h3>';
      const meta = service.extractMetadata(html);
      expect(meta.description).toBe('Tournament starts on Monday\nContact: admin@test.com');
    });

    it('should count players from table rows', () => {
      const html = `
        <tr class="CRg1 CAN"><td>1</td></tr>
        <tr class="CRg2 CAN"><td>2</td></tr>
        <tr class="CRg1 CAN"><td>3</td></tr>
      `;
      const meta = service.extractMetadata(html);
      expect(meta.playerCount).toBe(3);
    });

    it('should extract last update date', () => {
      const html = '<p class="CRsmall">Last update 05.09.2023 01:31:41, Creator: test</p>';
      const meta = service.extractMetadata(html);
      expect(meta.lastUpdate).toBe('05.09.2023');
    });

    it('should return nulls when no metadata found', () => {
      const html = '<html><body>Empty</body></html>';
      const meta = service.extractMetadata(html);
      expect(meta.description).toBeNull();
      expect(meta.playerCount).toBeNull();
      expect(meta.lastUpdate).toBeNull();
    });

    it('should truncate long descriptions', () => {
      const longText = 'A'.repeat(600);
      const html = `<h3 Class="CRmsg">${longText}</h3>`;
      const meta = service.extractMetadata(html);
      expect(meta.description!.length).toBeLessThanOrEqual(500);
      expect(meta.description!.endsWith('...')).toBe(true);
    });
  });
});
