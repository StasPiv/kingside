global:
  resolve_timeout: 5m

# Шаблоны подключаются через --config.file. Переменные __TELEGRAM_BOT_TOKEN__ и
# __TELEGRAM_CHAT_ID__ подставляются в docker-compose через envsubst/sed (см. сервис alertmanager).

route:
  receiver: telegram-prod
  group_by: ["alertname", "severity", "service"]
  group_wait: 10s
  group_interval: 1m
  repeat_interval: 4h
  routes:
    - matchers:
        - severity = "critical"
      receiver: telegram-prod
      repeat_interval: 30m
      continue: true
    - matchers:
        - severity = "warning"
      receiver: telegram-prod
      repeat_interval: 4h

receivers:
  - name: telegram-prod
    telegram_configs:
      - send_resolved: true
        bot_token: "__TELEGRAM_BOT_TOKEN__"
        chat_id: __TELEGRAM_CHAT_ID__
        parse_mode: HTML
        message: |
          <b>[{{ .Status | toUpper }}] {{ .CommonLabels.alertname }}</b>
          {{ if .CommonLabels.severity }}severity: <b>{{ .CommonLabels.severity }}</b>{{ end }}
          {{ if .CommonLabels.service }}service: {{ .CommonLabels.service }}{{ end }}
          {{ range .Alerts }}
          • {{ .Annotations.summary }}
          {{ if .Annotations.description }}<i>{{ .Annotations.description }}</i>{{ end }}
          {{ end }}

inhibit_rules:
  - source_matchers:
      - severity = "critical"
    target_matchers:
      - severity = "warning"
    equal: ["alertname", "service"]
