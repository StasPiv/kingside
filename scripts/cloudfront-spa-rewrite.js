// CloudFront Function (cloudfront-js-2.0), viewer-request.
// Назначение: маппинг URI для prerendered публичных маршрутов и SPA-fallback
// для всего остального.
//
// Логика:
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
        '/feedback': 1,
        '/features': 1,
        '/login': 1
    };

    var normalized = uri;
    if (normalized.length > 1 && normalized.charAt(normalized.length - 1) === '/') {
        normalized = normalized.substring(0, normalized.length - 1);
    }

    if (publicRoutes[normalized]) {
        request.uri = normalized + '/index.html';
        return request;
    }

    request.uri = '/index.html';
    return request;
}
