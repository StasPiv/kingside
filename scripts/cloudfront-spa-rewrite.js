// CloudFront Function (cloudfront-js-2.0), viewer-request.
// Назначение: маппинг URI для prerendered публичных маршрутов и SPA-fallback
// для всего остального.
//
// Логика:
//   - URI вида /tactic-puzzles или /tactic-puzzles/... → 301-перенаправление
//     на /critical-moment$1 с сохранением query-string (KS-4386, T3 KS-4383).
//     API /api/tactic-puzzles/* идёт к backend через другой Behavior CF и
//     этой функцией не обрабатывается — для него правило не применяется.
//   - URI вида /blog или /blog/... → 301-перенаправление на /en/blog$1
//     (legacy блог-URL после KS-4460, дефолтный язык — en).
//   - URI содержит точку (статика: .js/.css/.png/...) → пропускаем как есть
//   - URI === "/" → пропускаем (DefaultRootObject отдаст /index.html)
//   - URI вида "/<route>" или "/<route>/" и <route> в publicRoutes
//        → переписываем в "/<route>/index.html" (пререндеренная страница)
//   - URI вида "/<lang>/blog/<slug>" (lang ∈ {en, ru}, один сегмент после
//        префикса) → "/<lang>/blog/<slug>/index.html" (snapshot статьи блога,
//        KS-4463 / KS-4460)
//   - всё прочее (приватные маршруты, вложенные пути) → "/index.html" (SPA-fallback)
//
// Список publicRoutes синхронизируется с apps/web/src/config/publicRoutes.ts (KS-4116).
// При изменении состава публичных маршрутов — обновить этот файл и публикацию функции
// (см. scripts/cloudfront-deploy-spa-rewrite.sh).
function redirect301(newUri, qs) {
    var qsString = '';
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

function handler(event) {
    var request = event.request;
    var uri = request.uri;

    // KS-4386: 301 /tactic-puzzles(/.*)? → /critical-moment$1
    // Условие: URI == '/tactic-puzzles' либо начинается с '/tactic-puzzles/'.
    // Hash (#…) браузер серверу не шлёт — сохранится автоматически на стороне
    // клиента при следовании 301-ответу. Query-string копируем явно.
    if (uri === '/tactic-puzzles' || uri.indexOf('/tactic-puzzles/') === 0) {
        var newUri = '/critical-moment' + uri.substring('/tactic-puzzles'.length);
        return redirect301(newUri, request.querystring);
    }

    // KS-4461: 301 /blog(/.*)? → /en/blog$1 (legacy блог-URL после KS-4460).
    // После KS-4460 фронт перевёл блог на префиксные `/en/blog` и `/ru/blog`,
    // старые `/blog[/<slug>]` редиректили только клиентским `<Navigate>` —
    // поисковики без JS этого не видят. Дефолтный язык — `en` (зафиксировано
    // во фронте, не cookie/Accept-Language).
    if (uri === '/blog' || uri.indexOf('/blog/') === 0) {
        var blogNewUri = '/en/blog' + uri.substring('/blog'.length);
        return redirect301(blogNewUri, request.querystring);
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
        // KS-4463: ленты блога с языковым префиксом. Старый `/blog`
        // редиректится выше 301-м на `/en/blog`. Snapshot'ы лежат в
        // `dist/<lang>/blog/index.html` (KS-4460).
        '/en/blog': 1,
        '/ru/blog': 1
    };

    var normalized = uri;
    if (normalized.length > 1 && normalized.charAt(normalized.length - 1) === '/') {
        normalized = normalized.substring(0, normalized.length - 1);
    }

    if (publicRoutes[normalized]) {
        request.uri = normalized + '/index.html';
        return request;
    }

    // KS-4463: статьи блога с языковым префиксом — `/<lang>/blog/<slug>`.
    // prerender кладёт каждую в `dist/<lang>/blog/<slug>/index.html`
    // (KS-4460, аналог старой схемы из KS-4448). Без этой ветки путь
    // уходит в SPA-fallback на корневой `/index.html` (landing-разметка),
    // и snapshot со статьёй не попадает к ботам / первому заходу.
    // Условия: URI начинается с `/en/blog/` или `/ru/blog/`, ровно
    // один непустой сегмент после префикса (нет вложенного слеша).
    // Несуществующий slug → S3 вернёт 404, CloudFront-фолбэк
    // (Custom Error Response) отдаст корневой `/index.html`.
    var langPrefix = null;
    if (normalized.indexOf('/en/blog/') === 0) {
        langPrefix = '/en/blog/';
    } else if (normalized.indexOf('/ru/blog/') === 0) {
        langPrefix = '/ru/blog/';
    }
    if (langPrefix !== null
        && normalized.indexOf('/', langPrefix.length) === -1
        && normalized.length > langPrefix.length) {
        request.uri = normalized + '/index.html';
        return request;
    }

    request.uri = '/index.html';
    return request;
}
