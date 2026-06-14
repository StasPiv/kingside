# ADR-095 Этап A — минимальный образ для smoke OAuth Claude Pro/Max.
# Цель — проверить, можно ли переносить ~/.claude/.credentials.json
# в чужой контейнер и стабильно запускать `claude` CLI с OAuth-creds.
#
# ВАЖНО: credentials НЕ копируются в образ. Они монтируются bind-mount'ом
# при `docker run -v <host>/.credentials.json:/home/runtime/.claude/.credentials.json:ro`.

FROM node:20-slim

# Устанавливаем claude CLI глобально (тот же пакет, что в нашем агентском образе).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code@2.1.141

# Непривилегированный пользователь — чтобы claude CLI не работал из-под root
# (Anthropic рекомендует non-root, плюс это ближе к реальному ECS-окружению).
RUN useradd -m -u 1001 -s /bin/bash runtime \
    && mkdir -p /home/runtime/.claude \
    && chown -R runtime:runtime /home/runtime

USER runtime
WORKDIR /home/runtime

# Smoke-скрипты копируем в образ (read-only, не содержат секретов).
COPY --chown=runtime:runtime s1.sh s3.sh s4.sh /home/runtime/

# Точка входа — bash, чтобы пользователь выбрал нужный сценарий руками.
# (Не CMD claude --print "test" — потому что для S3/S4 нужны другие скрипты.)
CMD ["/bin/bash"]
