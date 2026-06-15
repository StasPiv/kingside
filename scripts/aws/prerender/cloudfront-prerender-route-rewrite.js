// CloudFront Function (cloudfront-js-2.0), viewer-request.
//
// Назначение: маппинг URI вида `/{section}/{id}` → `/{section}/{id}/index.html`
// для динамически отрендеренных публичных страниц (ADR-128 §7.3.4).
//
// Функция привязывается к behaviors на префиксы:
//   /broadcasts/*, /tournaments/*, /arena/*, /lectures/*,
//   /coach/*, /player/*, /archive/games/*, /archive/players/*
// и переписывает URI в соответствующий ключ S3 в бакете kingside-prerender-store.
//
// Если объекта в S3 нет — CloudFront вернёт 404 с origin'а, а CustomErrorResponse
// на distribution заменит ответ на корневой /index.html (HTTP 200). Так SPA
// перехватит маршрут и отрисует страницу клиентским рендером.
//
// Конкретно матчатся пути:
//   /broadcasts/{id}   /broadcasts/{id}/
//   /tournaments/{id}  /tournaments/{id}/
//   /arena/{id}        /arena/{id}/
//   /lectures/{id}     /lectures/{id}/
//   /coach/{id}        /coach/{id}/
//   /player/{id}       /player/{id}/
//   /archive/games/{id}    /archive/games/{id}/
//   /archive/players/{id}  /archive/players/{id}/
//
// Если запрос содержит дополнительные сегменты (`/broadcasts/foo/bar`) — функция
// его не трогает, и S3 ожидаемо отдаст 404 → fallback.

function handler(event) {
    var request = event.request;
    var uri = request.uri;

    // Статика (содержит точку) — пропускаем как есть.
    if (uri.indexOf('.') !== -1) {
        return request;
    }

    // Нормализуем хвостовой `/`.
    var path = uri;
    if (path.length > 1 && path.charAt(path.length - 1) === '/') {
        path = path.substring(0, path.length - 1);
    }

    var parts = path.split('/');
    // parts[0] всегда '' из-за ведущего слэша.

    // Односегментные секции: /{section}/{id}
    var singleSections = {
        broadcasts: 1,
        tournaments: 1,
        arena: 1,
        lectures: 1,
        coach: 1,
        player: 1
    };
    if (parts.length === 3 && singleSections[parts[1]] && parts[2].length > 0) {
        request.uri = '/' + parts[1] + '/' + parts[2] + '/index.html';
        return request;
    }

    // Двухсегментные секции архива: /archive/{games|players}/{id}
    if (parts.length === 4 && parts[1] === 'archive'
            && (parts[2] === 'games' || parts[2] === 'players')
            && parts[3].length > 0) {
        request.uri = '/archive/' + parts[2] + '/' + parts[3] + '/index.html';
        return request;
    }

    // Не подошло под шаблон — пропускаем (origin ответит 404, distribution-level
    // CustomErrorResponse переведёт на /index.html со статусом 200).
    return request;
}
