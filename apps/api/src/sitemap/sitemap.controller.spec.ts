/**
 * KS-4209. `/robots.txt` отдаёт корректный текст со ссылкой на
 * sitemap-index.
 */
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SitemapController } from './sitemap.controller';

async function makeController(env: Record<string, string>): Promise<SitemapController> {
  const moduleRef = await Test.createTestingModule({
    controllers: [SitemapController],
    providers: [
      {
        provide: ConfigService,
        useValue: { get: (k: string) => env[k] },
      },
    ],
  }).compile();
  return moduleRef.get(SitemapController);
}

describe('SitemapController.robots', () => {
  it('содержит Sitemap: на корневой sitemap.xml', async () => {
    const c = await makeController({ PUBLIC_BASE_URL: 'https://kingside.site' });
    const body = c.robots();
    expect(body).toContain('Sitemap: https://kingside.site/sitemap.xml');
  });

  it('закрывает /api/ /admin/ /internal/', async () => {
    const c = await makeController({ PUBLIC_BASE_URL: 'https://kingside.site' });
    const body = c.robots();
    expect(body).toMatch(/Disallow: \/api\//);
    expect(body).toMatch(/Disallow: \/admin\//);
    expect(body).toMatch(/Disallow: \/internal\//);
  });

  it('разрешает всё остальное (User-agent: * + Allow: /)', async () => {
    const c = await makeController({ PUBLIC_BASE_URL: 'https://kingside.site' });
    const body = c.robots();
    expect(body).toMatch(/User-agent: \*/);
    expect(body).toMatch(/Allow: \//);
  });

  it('без PUBLIC_BASE_URL — fallback на https://kingside.site', async () => {
    const c = await makeController({});
    const body = c.robots();
    expect(body).toContain('Sitemap: https://kingside.site/sitemap.xml');
  });

  it('убирает trailing slash у baseUrl', async () => {
    const c = await makeController({ PUBLIC_BASE_URL: 'https://kingside.site/' });
    const body = c.robots();
    expect(body).toContain('Sitemap: https://kingside.site/sitemap.xml');
    expect(body).not.toContain('https://kingside.site//sitemap.xml');
  });
});
