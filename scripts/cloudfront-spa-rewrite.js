// CloudFront Function (cloudfront-js-2.0), viewer-request.
// Назначение: маппинг URI для prerendered публичных маршрутов и SPA-fallback
// для всего остального.
//
// Логика:
//   - URI вида /tactic-puzzles или /tactic-puzzles/... → 301-перенаправление
//     на /critical-moment$1 с сохранением query-string (KS-4386, T3 KS-4383).
//     API /api/tactic-puzzles/* идёт к backend через другой Behavior CF и
//     этой функцией не обрабатывается — для него правило не применяется.
//   - URI содержит точку (статика: .js/.css/.png/...) → пропускаем как есть
//   - URI === "/" → пропускаем (DefaultRootObject отдаст /index.html)
//   - URI вида "/<route>" или "/<route>/" и <route> в publicRoutes
//        → переписываем в "/<route>/index.html" (пререндеренная страница)
//   - всё прочее (приватные маршруты, вложенные пути) → "/index.html" (SPA-fallback)
//
// Список publicRoutes синхронизируется с apps/web/src/config/publicRoutes.ts (KS-4116).
// При изменении состава публичных маршрутов — обновить этот файл и публикацию функции
// (см. scripts/cloudfront-deploy-spa-rewrite.sh).
function handler(event) {
    var request = event.request;
    var uri = request.uri;

    // KS-4386: 301 /tactic-puzzles(/.*)? → /critical-moment$1
    // Условие: URI == '/tactic-puzzles' либо начинается с '/tactic-puzzles/'.
    // Hash (#…) браузер серверу не шлёт — сохранится автоматически на стороне
    // клиента при следовании 301-ответу. Query-string копируем явно.
    if (uri === '/tactic-puzzles' || uri.indexOf('/tactic-puzzles/') === 0) {
        var newUri = '/critical-moment' + uri.substring('/tactic-puzzles'.length);
        var qsString = '';
        var qs = request.querystring;
        if (qs) {
            var parts = [];
            for (var k in qs) {
                if (qs[k].multiValue) {
                    for (var i = 0; i < qs[k].multiValue.length; i++) {
                        parts.push(k + '=' + qs[k].multiValue[i].value);
                    }
                } else if (qs[k].value !== undefined) {
                    parts.push(k + '=' + qs[k].value);
                } else {
                    parts.push(k);
                }
            }
            if (parts.length > 0) {
                qsString = '?' + parts.join('&');
            }
        }
        return {
            statusCode: 301,
            statusDescription: 'Moved Permanently',
            headers: {
                'location': { value: newUri + qsString },
                'cache-control': { value: 'public, max-age=3600' }
            }
        };
    }

    if (uri.indexOf('.') !== -1) {
        return request;
    }

    if (uri === '/') {
        return request;
    }

    var publicRoutes = {
        '/play': 1,
        '/lobby': 1,
        '/tournaments': 1,
        '/puzzles': 1,
        '/daily': 1,
        '/puzzle-rush': 1,
        '/analysis': 1,
        '/workshop': 1,
        '/broadcasts': 1,
        '/players': 1,
        '/lectures': 1,
        '/feedback': 1,
        '/features': 1,
        '/login': 1,
        // KS-4448 / ADR-137. Лента блога — пророс через prerender.mjs
        // (snapshot из BLOG_ROUTES + статика).
        '/blog': 1
    };

    var normalized = uri;
    if (normalized.length > 1 && normalized.charAt(normalized.length - 1) === '/') {
        normalized = normalized.substring(0, normalized.length - 1);
    }

    if (publicRoutes[normalized]) {
        request.uri = normalized + '/index.html';
        return request;
    }

    // KS-4448 / ADR-137 T6. Статьи блога — динамические URL вида
    // `/blog/<slug>`. prerender.mjs кладёт каждую в
    // `dist/blog/<slug>/index.html` (см. BLOG_ROUTES из
    // generated/blog-routes.ts). Без этой ветки путь уходит в
    // SPA-fallback на корневой `/index.html` (landing-разметка),
    // и snapshot со статьёй вообще не показывается ботам/первому
    // заходу. Условие — URI начинается с `/blog/` и в нём ровно
    // один сегмент после префикса (нет вложенного слеша).
    // Несуществующий slug → S3 вернёт 404, CloudFront-фолбэк
    // (Custom Error Response) отдаст корневой `/index.html`.
    if (normalized.indexOf('/blog/') === 0
        && normalized.indexOf('/', '/blog/'.length) === -1
        && normalized.length > '/blog/'.length) {
        request.uri = normalized + '/index.html';
        return request;
    }

    request.uri = '/index.html';
    return request;
}
