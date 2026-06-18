"""Пост-валидатор исходящих сообщений агентов.

Долгоживущий claude-CLI процесс в контейнере kingside-agent (без MCP, без tools).
Принимает текст, возвращает {"ok": true} или {"ok": false, "violations": [...]}.
Правила берутся из CLAUDE.md (~/.claude и проектный), hot-reload по mtime.
Авторизация — через подписку (~/.claude.json), не через API-ключ.
"""

import json
import os
import subprocess
import threading
import time

VALIDATOR_RULES_PATHS = [
    "/home/pivovartsev/.claude/CLAUDE.md",
    "/home/pivovartsev/work/kingside/CLAUDE.md",
]
VALIDATOR_IDLE_TTL = 30 * 60
VALIDATOR_TIMEOUT = 45
VALIDATOR_MODEL = "default"
VALIDATOR_CONTAINER = "validator"

AGENT_CLAUDE_DIR = os.environ.get("AGENT_CLAUDE_DIR", os.path.expanduser("~/.claude"))
AGENT_CLAUDE_JSON = os.environ.get("AGENT_CLAUDE_JSON", os.path.expanduser("~/.claude.json"))
LOG_DIR = os.environ.get("LOG_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs"))

SYSTEM_PROMPT_TEMPLATE = """Ты — пост-валидатор исходящих сообщений ИИ-агентов перед отправкой пользователю.

Единственная задача: проверить, нарушает ли сообщение правила общения из CLAUDE.md, и вернуть JSON-вердикт. Больше ничего не делать.

=== Правила из ~/.claude/CLAUDE.md ===
{global_rules}

=== Правила из проекта /home/pivovartsev/work/kingside/CLAUDE.md ===
{project_rules}

=== Контекст запроса ===
Вместе с ответом агента тебе передаётся `user_prompt` — текст входящего сообщения, на которое агент отвечает. Используй его как контекст: уместность ответа оценивай ПО ОТНОШЕНИЮ к запросу, а не в вакууме.

Примеры:
- user_prompt: «иду делать?» → ответ агента «иду делать» = прямой ответ, не нарушение.
- user_prompt: «что планируешь?» → ответ агента с перечислением плана = по делу, не нарушение.
- user_prompt: «как дела с задачей?» → ответ агента «Ты прав, всё сделано» = нарушение (одобрение в начале без причины).
- user_prompt: «согласен ли ты с подходом?» → ответ агента «Согласен» = прямой ответ, не нарушение (одобрение есть, но это ответ на прямой вопрос).
- user_prompt: «делать?» → ответ агента «Делать?» = нарушение (агент задал риторический вопрос обратно).

Если поля `user_prompt` нет или пустое — оценивай в общем виде по правилам ниже.

=== Что проверять ===
Только пункты CLAUDE.md, касающиеся ТОНА, СТИЛЯ и ФОРМЫ обращения к пользователю:
- запрет начинать с одобрения («Ты прав», «Я ошибся», «Сейчас сделаю правильно», «Согласен» и их вариаций);
- запрет самобичевания (посыпание головы пеплом, многократные извинения, «я подвёл»);
- запрет заканчивать риторическими вопросами или предложениями («Делать?», «Если хочешь», «Продолжать?»);
- запрет на IT-сленг («фикс», «запушить», «апрувнуть», «замерджить», «задеплоить», «прокинуть», «зафейлилось», «коммитнуть» и подобные) — допустимы только устоявшиеся термины без русского эквивалента;
- запрет на субъективные суждения о критичности («не критично», «не важно», «можно пренебречь»);
- ответ должен быть на русском языке, по делу.

=== 🔴 Жёсткое правило лаконичности ===
ЛЮБОЙ ответ агента ДОЛЖЕН быть максимально кратким — обычно 1-3 предложения, максимум 5-7. Длинные сообщения создают иллюзию работы и используются для введения пользователя в заблуждение.

ЗАПРЕЩЕНО:
- структурированные отчёты с заголовками/буллетами/таблицами на простой вопрос;
- перечисление того что сделал/попробовал/исследовал в ответ на «как дела?» / «что там?» / «работает?»;
- технические объяснения «почему я не смог» если не запросили обоснование;
- описание процесса вместо ответа на вопрос;
- «defensive narrative» — длинное оправдание с перечислением альтернатив, контекста, рисков, теоретических артефактов;
- повторное изложение того, что собеседник уже знает.

ИСКЛЮЧЕНИЕ — длинный ответ допустим ТОЛЬКО когда user_prompt явно его запрашивает: «распиши», «опиши подробно», «дай развёрнутый отчёт», «перечисли всё», «расскажи поэтапно», «детально объясни». Без такого явного запроса любое сообщение длиннее 5-7 предложений — нарушение.

Если у тебя сомнение «может быть это уместное объяснение?» — ответ нет, режь. Описание правила в violation: «многословие без явного запроса подробного отчёта».

=== Слова против дела ===
К каждому сообщению вместе с текстом тебе передаётся список инструментов, которые агент реально вызвал в этом turn'е (`tool_uses`). Проверь:

Если в тексте есть обещание действия в настоящем/ближайшем времени любой формулировки — «иду делать», «правлю прямо сейчас», «приступаю», «делаю», «сейчас сделаю», «коммичу», «исправлю сейчас», «приступил» и любые их вариации/синонимы — должен быть как минимум один tool_use вне набора {{`agent_message`, `telegram_send`, `issue_add_comment`, `issue_comments`, `Read`, `Grep`, `Glob`, `ToolSearch`}} в том же turn'е. Перечисленные исключения — это коммуникация и чтение, не «делание».

Если обещание есть, а ни одного реального tool_use нет — это нарушение «слова разошлись с делом»: агент после end-of-turn уйдёт в idle и не выполнит обещанного, пока не придёт следующий внешний triggering сигнал. Описание правила в violation: «слова разошлись с делом — обещание действия без tool_use».

Если в тексте обещаний действия нет (просто ответ на вопрос, описание состояния, отчёт о уже сделанном в прошлых turn'ах) — это правило игнорируй, даже если tool_use'ы пустые.

НЕ проверяй: пункты про код, git, MCP-тулы, инфраструктуру, метки задач, ownership — это не про текст сообщения.

=== Формат ответа ===
Возвращай ТОЛЬКО один валидный JSON-объект, без markdown, без пояснений снаружи:

Если сообщение чистое:
{{"ok": true}}

Если есть нарушения:
{{"ok": false, "violations": [{{"rule": "краткое описание нарушенного пункта", "fragment": "кусок текста-нарушения", "suggestion": "как переписать этот фрагмент"}}]}}

Допускается несколько объектов в массиве violations.
"""


class ValidatorDaemon:
    """Один долгоживущий claude-процесс для валидации outbound-сообщений."""

    def __init__(self):
        self.proc = None
        self.lock = threading.Lock()
        self._reader_thread = None
        self._resume_session_id = None
        self._response_text = ""
        self._response_ready = threading.Event()
        self._collecting = False
        self._rules_mtime = 0.0
        self._system_prompt = ""
        self._last_activity = time.time()

    def _read_rules(self):
        parts = []
        max_mtime = 0.0
        for path in VALIDATOR_RULES_PATHS:
            try:
                m = os.path.getmtime(path)
                if m > max_mtime:
                    max_mtime = m
                with open(path) as f:
                    parts.append(f.read())
            except OSError:
                parts.append("")
        prompt = SYSTEM_PROMPT_TEMPLATE.format(
            global_rules=parts[0] if len(parts) > 0 else "",
            project_rules=parts[1] if len(parts) > 1 else "",
        )
        return prompt, max_mtime

    def _rules_changed(self):
        for path in VALIDATOR_RULES_PATHS:
            try:
                if os.path.getmtime(path) > self._rules_mtime:
                    return True
            except OSError:
                continue
        return False

    def _build_cmd(self):
        cmd = [
            "docker", "run", "--rm", "-i",
            "--name", VALIDATOR_CONTAINER,
            "--network", "host",
            "-v", f"{AGENT_CLAUDE_DIR}:/home/agent/.claude",
            "-v", f"{AGENT_CLAUDE_JSON}:/home/agent/.claude.json",
            "kingside-agent",
            "-p",
            "--model", VALIDATOR_MODEL,
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--verbose",
            "--strict-mcp-config",
            "--system-prompt", self._system_prompt,
        ]
        if self._resume_session_id:
            cmd.extend(["--resume", self._resume_session_id])
        return cmd

    def start(self):
        self._system_prompt, self._rules_mtime = self._read_rules()
        subprocess.run(
            ["docker", "kill", VALIDATOR_CONTAINER],
            capture_output=True, timeout=10,
        )
        cmd = self._build_cmd()
        env = os.environ.copy()
        env.pop("CLAUDECODE", None)
        log_path = os.path.join(LOG_DIR, "validator.log")
        try:
            lf = open(log_path, "a", buffering=1)
        except OSError:
            lf = subprocess.DEVNULL
        self.proc = subprocess.Popen(
            cmd, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=lf,
            start_new_session=True, text=True, bufsize=1,
        )
        self._last_activity = time.time()
        self._reader_thread = threading.Thread(target=self._read_stdout, daemon=True)
        self._reader_thread.start()

    def _read_stdout(self):
        try:
            for line in iter(self.proc.stdout.readline, ""):
                line_s = line.strip()
                if not line_s:
                    continue
                try:
                    data = json.loads(line_s)
                except (json.JSONDecodeError, ValueError):
                    continue
                t = data.get("type")
                if t == "system" and data.get("subtype") == "init":
                    sid = data.get("session_id")
                    if sid:
                        self._resume_session_id = sid
                if t == "assistant" and self._collecting:
                    for block in data.get("message", {}).get("content", []):
                        if block.get("type") == "text":
                            self._response_text += block.get("text", "")
                if t == "result":
                    if not self._response_text:
                        self._response_text = data.get("result", "")
                    self._collecting = False
                    self._response_ready.set()
        except Exception:
            pass
        finally:
            try:
                if self.proc and self.proc.stdout:
                    self.proc.stdout.close()
            except OSError:
                pass
            self._response_ready.set()

    def validate(self, text: str, tool_uses: list[str] | None = None, user_prompt: str = "", timeout: float = VALIDATOR_TIMEOUT) -> dict:
        """Возвращает {"ok": bool, "violations": [...]} или {"ok": True, "error": "..."} при сбое.

        tool_uses — список имён MCP-/CLI-инструментов, реально вызванных агентом
        в этом turn'е (для проверки правила «слова против дела»).
        """
        if not text or not text.strip():
            return {"ok": True}

        with self.lock:
            if self._rules_changed():
                self.stop()

            if not self.proc or self.proc.poll() is not None:
                try:
                    self.start()
                except Exception as e:
                    return {"ok": True, "error": f"validator start failed: {e}"}

            self._response_text = ""
            self._response_ready.clear()
            self._collecting = True
            self._last_activity = time.time()

            tools_block = (
                f"\n\nИнструменты, вызванные в этом turn'е (`tool_uses`): {json.dumps(tool_uses or [], ensure_ascii=False)}"
            )
            prompt_block = (
                f"\n\nЗапрос, на который агент отвечает (`user_prompt`):\n```\n{user_prompt}\n```"
                if user_prompt else ""
            )
            user_msg = json.dumps({
                "type": "user",
                "message": {
                    "role": "user",
                    "content": (
                        f"Ответ агента на проверку:\n\n```\n{text}\n```"
                        f"{prompt_block}{tools_block}\n\nВерни JSON-вердикт."
                    ),
                },
            })

            try:
                self.proc.stdin.write(user_msg + "\n")
                self.proc.stdin.flush()
            except (BrokenPipeError, OSError) as e:
                return {"ok": True, "error": f"validator pipe broken: {e}"}

            if not self._response_ready.wait(timeout=timeout):
                self._collecting = False
                return {"ok": True, "error": f"validator timeout ({timeout}s)"}

            raw = self._response_text.strip()
            if not raw:
                return {"ok": True, "error": "validator empty response"}

            start = raw.find("{")
            end = raw.rfind("}")
            if start < 0 or end <= start:
                return {"ok": True, "error": f"validator bad output: {raw[:200]}"}
            try:
                parsed = json.loads(raw[start:end + 1])
                if not isinstance(parsed, dict) or "ok" not in parsed:
                    return {"ok": True, "error": f"validator malformed: {raw[:200]}"}
                return parsed
            except (json.JSONDecodeError, ValueError) as e:
                return {"ok": True, "error": f"validator json parse: {e}"}

    def stop(self):
        if self.proc:
            try:
                self.proc.terminate()
                self.proc.wait(timeout=5)
            except (subprocess.TimeoutExpired, OSError):
                try:
                    self.proc.kill()
                except OSError:
                    pass
            self.proc = None
        subprocess.run(
            ["docker", "kill", VALIDATOR_CONTAINER],
            capture_output=True, timeout=10,
        )


_validator = ValidatorDaemon()


def validate_outbound(text: str, tool_uses: list[str] | None = None, user_prompt: str = "") -> dict:
    """Точка входа из webhook-server.py."""
    return _validator.validate(text, tool_uses=tool_uses, user_prompt=user_prompt)


def format_violations(result: dict) -> str:
    """Превращает результат валидации в текст-инструкцию для агента."""
    violations = result.get("violations") or []
    if not violations:
        return ""
    lines = []
    for v in violations:
        rule = v.get("rule", "правило CLAUDE.md")
        fragment = v.get("fragment", "")
        suggestion = v.get("suggestion", "")
        line = f"  - {rule}"
        if fragment:
            line += f"\n    фрагмент: «{fragment[:160]}»"
        if suggestion:
            line += f"\n    как переписать: {suggestion[:200]}"
        lines.append(line)
    return "\n".join(lines)
