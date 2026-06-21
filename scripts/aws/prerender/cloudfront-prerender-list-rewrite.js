// CloudFront Function (cloudfront-js-2.0), viewer-request.
//
// Назначение: маппинг URI exact-match списочных маршрутов на ключи S3
// в бакете kingside-prerender-store (ADR-128 §7.3.4).
//
// Привязывается к behaviors с exact PathPattern:
//   /broadcasts, /tournaments, /lectures, /players, /archive, /sitemap*
//
// Воркер prerender-service пишет файлы как `list/<entity>.html`.
//
// При отсутствии файла CustomErrorResponses на distribution (KS-4225)
// возвращает /index.html (200) — SPA подхватывает маршрут клиентским рендером.
//
// KS-4284: для запросов от prerender-воркера (UA содержит `KingsidePrerender`)
// переписываем URI на `/__prerender-bypass`. S3-prerender 404 → CER → /index.html
// → актуальный SPA-shell из frontend bucket. Разрывает петлю воркера.
//
// KS-4484: для удалённых архивных sitemap'ов (`sitemap-archive-games.xml`,
// `sitemap-archive-players.xml`) возвращаем 410 Gone — без этой ветки
// CER на S3-404 отдал бы 200 + `/index.html`, и Google продолжил бы
// считать sitemap валидным. 410 — явный сигнал «убрать из индекса».

function handler(event) {
    var request = event.request;
    var uri = request.uri;
    var headers = request.headers;

    // KS-4284: bypass prerender-петли по User-Agent воркера.
    var uaHeader = headers['user-agent'];
    var ua = (uaHeader && uaHeader.value) || '';
    if (ua.indexOf('KingsidePrerender') !== -1) {
        request.uri = '/__prerender-bypass';
        return request;
    }

    // KS-4484: 410 Gone для удалённых архивных sitemap'ов.
    if (uri === '/sitemap-archive-games.xml' || uri === '/sitemap-archive-players.xml') {
        return {
            statusCode: 410,
            statusDescription: 'Gone',
            headers: {
                'content-type': { value: 'text/plain; charset=utf-8' },
                'cache-control': { value: 'public, max-age=3600' }
            }
        };
    }

    // Нормализуем хвостовой `/`.
    var path = uri;
    if (path.length > 1 && path.charAt(path.length - 1) === '/') {
        path = path.substring(0, path.length - 1);
    }

    var listSections = {
        '/broadcasts': 'broadcasts',
        '/tournaments': 'tournaments',
        '/lectures': 'lectures',
        '/players': 'players',
        '/archive': 'archive'
    };

    var key = listSections[path];
    if (key) {
        request.uri = '/list/' + key + '.html';
        return request;
    }

    // Не должно сюда попасть — behavior привязывается строго к этим path-pattern'ам.
    return request;
}
