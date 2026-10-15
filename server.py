#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AI 文生图提示词工作台 —— 本地服务
仅依赖 Python 标准库，无需 pip 安装任何东西。

启动:  python3 server.py
"""

from __future__ import annotations

import json
import mimetypes
import os
import socket
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlparse
from urllib.request import Request, urlopen

# --------------------------------------------------------------------------
# 路径
#
# 两种运行方式：
#   1. 源码方式  python3 server.py     → 数据存在项目里的 data/
#   2. 打包成 App（PyInstaller 冻结）  → 资源在 bundle 内，数据写到用户目录
# --------------------------------------------------------------------------
APP_NAME = "AI-Prompt-Studio"


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def resource_dir() -> str:
    """只读资源（server.py 与 app/ 静态文件）所在目录。"""
    if is_frozen():
        # onefile: 解包临时目录；onedir: 内部资源目录
        return getattr(sys, "_MEIPASS", None) or os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def default_data_dir() -> str:
    """可写的用户数据目录。"""
    override = os.environ.get("APS_DATA_DIR")
    if override:
        return os.path.abspath(os.path.expanduser(override))
    if is_frozen():
        home = os.path.expanduser("~")
        if sys.platform == "darwin":
            return os.path.join(home, "Library", "Application Support", APP_NAME)
        if os.name == "nt":
            base = os.environ.get("APPDATA") or os.path.join(home, "AppData", "Roaming")
            return os.path.join(base, APP_NAME)
        return os.path.join(home, ".local", "share", APP_NAME)
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")


BASE_DIR = resource_dir()
APP_DIR = os.path.join(BASE_DIR, "app")
DATA_DIR = default_data_dir()

SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")
PRESETS_FILE = os.path.join(DATA_DIR, "presets.json")
HISTORY_FILE = os.path.join(DATA_DIR, "history.json")

# 内置标签库（随软件升级，只读）
TAGS_BUILTIN_FILE = os.path.join(APP_DIR, "data", "tags.json")
# 用户编辑后的标签库（存在时优先）
TAGS_USER_FILE = os.path.join(DATA_DIR, "tags.user.json")

DEFAULT_VISION_SYSTEM_PROMPT = """你是一位资深的 AI 绘画提示词工程师，精通 Stable Diffusion、Midjourney、DALL·E 等主流文生图模型。
请仔细观察用户提供的图片，反推出可直接使用的提示词。

要求：
1. 正向提示词（PROMPT）：英文，关键词之间用英文逗号分隔。按「主体 → 外貌/服装 → 动作表情 → 环境场景 → 光线 → 色彩 → 构图镜头 → 风格 → 画质」的顺序组织。
2. 负面提示词（NEGATIVE）：英文，给出通用的低画质与畸形类排除词。
3. 中文说明：把正向提示词逐项翻译成中文，并简述画面内容。

严格按以下三行格式输出，不要输出任何多余内容、不要使用 Markdown 代码块：

PROMPT: <英文正向提示词>
NEGATIVE: <英文负面提示词>
中文: <中文翻译与简要说明>"""


def _deep_merge(base: dict, incoming: dict) -> dict:
    """把 incoming 合并进 base 的副本，dict 递归合并。"""
    out = dict(base)
    for key, value in (incoming or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def default_settings() -> dict:
    return {
        "base_url": "https://api.openai.com/v1",
        "api_key": "",
        "model": "gpt-4o-mini",
        "vision_system_prompt": DEFAULT_VISION_SYSTEM_PROMPT,
        "vision_user_prompt": "请解析这张图片，输出可用于文生图模型的提示词。",
        "polish_system_prompt": DEFAULT_POLISH_SYSTEM_PROMPT,
        "language": "both",       # zh | en | both
        "theme": "system",        # system | light | dark（默认跟随系统）
        "append_mode": "comma",   # comma | space
        "timeout": 90,
        "max_tokens": 8192,
        "copy_prefix_mode": "negative",   # none | negative | both
        "copy_positive_prefix": "Positive prompt: ",
        "copy_negative_prefix": "Negative prompt: ",
        "parked": {"pos": [], "neg": []},
        "slots": [
            {"prompt": "", "negative": ""},
            {"prompt": "", "negative": ""},
            {"prompt": "", "negative": ""},
            {"prompt": "", "negative": ""},
        ],
    }


TRANSLATE_PROMPTS = {
    "zh2en": (
        "你是 AI 绘画提示词翻译专家。把用户给出的中文描述翻译成可直接用于文生图模型的英文提示词。\n"
        "要求：全小写；关键词之间用英文逗号加空格分隔；只输出翻译结果本身；"
        "不要输出解释、不要句号、不要引号、不要 Markdown 代码块。"
    ),
    "en2zh": (
        "你是 AI 绘画提示词翻译专家。把用户给出的英文提示词逐项翻译成中文。\n"
        "要求：保持原有顺序；用「英文（中文）」的形式逐项列出，项与项之间用中文逗号分隔；"
        "只输出翻译结果本身，不要解释、不要 Markdown 代码块。"
    ),
}

DEFAULT_POLISH_SYSTEM_PROMPT = """你是一位顶尖的 AI 绘画提示词工程师，精通 Stable Diffusion、ComfyUI、Midjourney、Flux、DALL·E 等主流文生图模型。
用户会给你一段已经写好的正向提示词（可能还有负面提示词），请你按用户指定的方式把它调优。

无论采用哪种调优方式，都必须遵守：
1. 严格按下面三行格式输出，不要输出任何多余内容，不要使用 Markdown 代码块：
PROMPT: <只放正向提示词>
NEGATIVE: <只放负面提示词>
说明: <用中文列出你做的关键修改，3-6 条，用分号隔开>
2. **正向和负向必须彻底分开**：正向内容只能出现在 PROMPT 行，负向内容只能出现在 NEGATIVE 行，
   任何情况下都不要把负面词（例如 low quality、blurry、watermark）混进 PROMPT。
3. 每一行都必须存在。某一行没有内容时写「无」，但行本身不能省略、不能合并。
4. 「说明」要具体到关键词级别，例如「补了 rim light 与 volumetric light 强化轮廓和光斑」「删掉了重复的 beautiful 与 gorgeous」。
5. 顺手修掉模型识别不了的写法：中文、句号、引号、书名号、多余空格、无意义修饰词。
6. 不要输出任何与画面无关的寒暄。"""

POLISH_STYLES = {
    "balanced": (
        "【调优方式：均衡调优】\n"
        "在完全保留用户原意和已有元素的前提下补齐明显缺失的关键维度（光线、构图、画质），"
        "修正不生效或冗余的写法，并按「主体 → 外貌/服装 → 动作表情 → 环境场景 → 光线 → 色彩 → 构图镜头 → 风格 → 画质」的顺序重排。"
        "不要凭空添加用户没有暗示的新主体或新风格。"
    ),
    "enrich": (
        "【调优方式：丰富细节】\n"
        "在原有主体完全不变的前提下大幅增强画面信息量：补充材质质感、光影层次、环境细节、情绪氛围、镜头参数等具体描述，"
        "让画面更饱满、更有质感。可以新增元素，但必须与用户原意一致，不要改变主体与风格方向。"
    ),
    "simplify": (
        "【调优方式：精简凝练】\n"
        "做减法：删掉同义重复、互相冲突、影响力低、或已经被更具体词覆盖的标签，合并近义词，"
        "只保留最关键的 20–35 个词。宁可少而准，不要多而杂。核心主体与风格必须保留。"
    ),
    "reorder": (
        "【调优方式：规范排序】\n"
        "只做重排与格式规范化：把关键词调整为标准顺序，统一小写、统一用英文逗号加空格分隔、去掉重复与多余空格。"
        "**严禁新增、删除或替换任何关键词**。负面提示词也按通用顺序重排。"
    ),
    "fix": (
        "【调优方式：纠错修正】\n"
        "只做纠错：修正拼写错误、语法错误、模型无法识别的写法，删除互相冲突的词（例如同时出现 indoors 与 outdoors、"
        "白天与夜晚、写实与卡通）。**不要新增关键词**，也不要改变整体风格与画面内容。"
    ),
}

POLISH_TARGETS = {
    "tags": (
        "【输出目标：通用标签式，适用于 Stable Diffusion / ComfyUI / NovelAI】\n"
        "保持标签式写法：全小写英文关键词，用英文逗号加空格分隔，可以使用 (关键词:权重) 语法。"
    ),
    "midjourney": (
        "【输出目标：Midjourney】\n"
        "PROMPT 改成 Midjourney 风格：主体用简短的英文自然短语描述，关键词之间用英文逗号分隔，"
        "并在末尾附上合适的 --ar 与 --stylize 参数（例如 --ar 16:9 --stylize 250）。\n"
        "不要使用 A1111 的括号权重语法。\n"
        "**绝对不要在 PROMPT 里写 --no**。负面关键词一律单独写在 NEGATIVE 行，只写关键词本身、不带 --no 前缀。"
        "（工具会在需要时自行拼成 --no 参数。）"
    ),
    "natural": (
        "【输出目标：自然语言描述，适用于 Flux / DALL·E / GPT-Image】\n"
        "PROMPT 改成连贯的英文自然语言：用 2–4 句话描述画面，不要用逗号堆砌关键词，不要使用括号权重语法。\n"
        "NEGATIVE **仍然必须单独一行**，写要排除的英文关键词（英文逗号分隔）。"
        "如果这个模型不需要负面提示词，就写「无」，但这一行不能省。"
    ),
}

POLISH_WEIGHTS_INSTRUCTION = """【额外任务：给出权重建议】
在「说明」这一行之后再输出一行：
WEIGHTS: <关键词>:<权重>, <关键词>:<权重>, ...

规则：
- 只对 PROMPT 里真实出现的关键词给建议，最多 12 个，按重要程度从高到低排列。
- 权重范围 0.5 – 1.6，保留一位小数。大于 1 表示要强化，小于 1 表示要弱化，1.0 不用列出。
- 关键词的写法必须与 PROMPT 中完全一致（大小写、空格都要一致）。
- 一个都不需要调整时，输出「WEIGHTS: 无」。
- 这一行里不要写任何解释，也不要加括号。"""


def ensure_data_dir() -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    for path, payload in (
        (SETTINGS_FILE, default_settings()),
        (PRESETS_FILE, {"presets": []}),
        (HISTORY_FILE, {"combos": []}),
    ):
        if not os.path.exists(path):
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2)


def load_tags():
    """用户库优先；没有则用内置库。"""
    if os.path.exists(TAGS_USER_FILE):
        data = read_json(TAGS_USER_FILE, None)
        if isinstance(data, dict) and isinstance(data.get("categories"), list):
            return data, "user"
    data = read_json(TAGS_BUILTIN_FILE, {"categories": []})
    return data, "builtin"


def sanitize_tags(categories):
    """校验并规整标签库，返回 (清理后的数据, 错误信息)。"""
    seen_en = set()
    out_categories = []
    seen_cat_ids = set()

    for index, cat in enumerate(categories):
        if not isinstance(cat, dict):
            return None, "第 %d 个分类不是对象" % (index + 1)
        cat_id = str(cat.get("id") or "").strip()
        name = str(cat.get("name") or "").strip()
        if not cat_id:
            return None, "第 %d 个分类缺少 id" % (index + 1)
        if not name:
            return None, "分类「%s」缺少中文名称" % cat_id
        if cat_id in seen_cat_ids:
            return None, "分类 id 重复：%s" % cat_id
        seen_cat_ids.add(cat_id)

        groups_out = []
        seen_group_ids = set()
        for group in cat.get("groups") or []:
            if not isinstance(group, dict):
                continue
            group_id = str(group.get("id") or "").strip() or "%s.g%d" % (cat_id, len(groups_out) + 1)
            if group_id in seen_group_ids:
                return None, "分组 id 重复：%s" % group_id
            seen_group_ids.add(group_id)

            tags_out = []
            for tag in group.get("tags") or []:
                if not isinstance(tag, dict):
                    continue
                zh = str(tag.get("zh") or "").strip()
                en = str(tag.get("en") or "").strip()
                if not zh or not en:
                    continue
                if "," in en or "，" in en:
                    return None, "标签「%s」的英文含逗号，请拆成多个标签" % en
                key = en.lower()
                if key in seen_en:
                    continue  # 全局去重，保留第一个
                seen_en.add(key)
                tags_out.append({"zh": zh, "en": en})

            groups_out.append(
                {
                    "id": group_id,
                    "name": str(group.get("name") or "").strip() or "未命名分组",
                    "nameEn": str(group.get("nameEn") or "").strip(),
                    "tags": tags_out,
                }
            )

        entry = {
            "id": cat_id,
            "name": name,
            "nameEn": str(cat.get("nameEn") or "").strip(),
            "icon": str(cat.get("icon") or "").strip(),
            "groups": groups_out,
        }
        if cat.get("negative"):
            entry["negative"] = True
        out_categories.append(entry)

    return out_categories, None


def read_json(path: str, fallback):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return fallback


def write_json(path: str, payload) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def _post_chat(base_url: str, api_key: str, body: dict, timeout: int):
    """发一次 /chat/completions，返回 (payload, error)。payload 含 content / reasoning / finishReason。"""
    url = base_url.rstrip("/") + "/chat/completions"
    request = Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer %s" % api_key,
            "User-Agent": "AIPromptStudio/0.1",
        },
        method="POST",
    )

    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", "replace")
    except HTTPError as exc:
        return None, {
            "status": 502,
            "error": "接口返回错误 %s" % exc.code,
            "detail": exc.read().decode("utf-8", "replace")[:1500],
            "url": url,
        }
    except URLError as exc:
        return None, {"status": 502, "error": "无法连接接口: %s" % exc.reason, "url": url}
    except socket.timeout:
        return None, {"status": 504, "error": "接口请求超时（%s 秒）" % timeout, "url": url}
    except Exception as exc:  # pragma: no cover
        return None, {"status": 500, "error": "请求异常: %s" % exc, "url": url}

    try:
        parsed = json.loads(raw)
    except Exception:
        return None, {"status": 502, "error": "接口返回的不是合法 JSON", "detail": raw[:1500]}

    if isinstance(parsed, dict) and parsed.get("error"):
        return None, {
            "status": 502,
            "error": "接口报错",
            "detail": json.dumps(parsed["error"], ensure_ascii=False),
        }

    choice = (parsed.get("choices") or [{}])[0] if isinstance(parsed, dict) else {}
    message = choice.get("message") or {}

    def flatten(value):
        if isinstance(value, list):
            return "".join(part.get("text", "") for part in value if isinstance(part, dict))
        return value or ""

    return {
        "content": str(flatten(message.get("content"))).strip(),
        "reasoning": str(flatten(
            message.get("reasoning_content") or message.get("reasoning")
        )).strip(),
        "finishReason": str(choice.get("finish_reason") or ""),
        "raw": raw,
    }, None


def try_list_models(base_url: str, api_key: str, timeout: int):
    """尝试 GET {base}/models（免费，能同时验证地址和 Key）。返回 (模型 id 列表, 错误信息)。"""
    url = base_url.rstrip("/") + "/models"
    request = Request(url, headers={
        "Authorization": "Bearer %s" % api_key,
        "User-Agent": "AIPromptStudio/0.1",
    })
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", "replace")
    except HTTPError as exc:
        return None, {
            "status": exc.code,
            "body": exc.read().decode("utf-8", "replace")[:600],
            "url": url,
        }
    except URLError as exc:
        return None, {"status": 0, "body": str(exc.reason), "url": url}
    except socket.timeout:
        return None, {"status": 504, "body": "请求超时", "url": url}
    except Exception as exc:
        return None, {"status": -1, "body": str(exc), "url": url}

    try:
        parsed = json.loads(raw)
    except Exception:
        return None, {"status": -2, "body": raw[:300], "url": url}

    if isinstance(parsed, dict) and parsed.get("error"):
        return None, {
            "status": 502,
            "body": json.dumps(parsed["error"], ensure_ascii=False)[:600],
            "url": url,
        }

    ids = [
        str(item["id"])
        for item in (parsed.get("data") or [])
        if isinstance(item, dict) and item.get("id")
    ]
    return ids, None


def friendly_http_error(status: int, body: str) -> str:
    if status in (401, 403):
        return "API Key 无效或没有权限（HTTP %d）" % status
    if status == 404:
        return "接口地址不对，找不到这个路径（HTTP 404）"
    if status == 429:
        return "请求太频繁或额度用完了（HTTP 429）"
    if status in (500, 502, 503, 504):
        return "服务端暂时不可用（HTTP %d）" % status
    if status == 0:
        return "连不上这个地址：%s" % body
    if status in (-1, -2):
        return "返回的不是预期的 JSON，地址可能填错了"
    return "请求失败（HTTP %d）" % status


def call_chat_completion(base_url: str, api_key: str, body: dict, timeout: int):
    """调用 OpenAI 兼容的 /chat/completions。

    返回 (payload, error)；payload = {content, reasoning, finishReason, raw}。
    对推理模型（返回 reasoning_content 的）做了两处兼容：
      1. 若接口因为 max_tokens 太大而报错，去掉该字段重试一次
      2. 若正文为空但思考过程不为空，返回可读的原因而不是一句"未返回内容"
    """
    payload, error = _post_chat(base_url, api_key, body, timeout)

    if error:
        detail = str(error.get("detail") or "").lower()
        if "max_tokens" in detail and "max_tokens" in body:
            retry_body = {k: v for k, v in body.items() if k != "max_tokens"}
            payload, error = _post_chat(base_url, api_key, retry_body, timeout)

    if error:
        return None, error

    # 推理模型的思考过程吃光了额度：自动把 max_tokens 翻倍再试一次
    asked = int(body.get("max_tokens") or 8192)
    if not payload["content"] and payload["reasoning"] and payload["finishReason"] == "length":
        bigger = min(65536, asked * 2)
        if bigger > asked:
            retry_body = dict(body)
            retry_body["max_tokens"] = bigger
            retry, retry_error = _post_chat(base_url, api_key, retry_body, timeout)
            if not retry_error:
                payload = retry
            if payload["content"]:
                return payload, None

    if not payload["content"]:
        reasoning = payload["reasoning"]
        if payload["finishReason"] == "length":
            return None, {
                "status": 502,
                "error": "模型输出被 max_tokens 截断了，正文还没写完"
                         "（推理模型的思考过程会先占用额度，已自动翻倍重试仍不够）。\n"
                         "解决办法：到「设置 → 最大输出长度」调大，"
                         "或换用非推理模型（gpt-4o-mini / qwen-plus 等）。",
                "reasoning": reasoning[:3000],
                "finishReason": payload["finishReason"],
            }
        if reasoning:
            return None, {
                "status": 502,
                "error": "模型只返回了思考过程，没有返回正文。\n"
                         "解决办法：调大「设置 → 最大输出长度」，或换用非推理模型"
                         "（gpt-4o-mini / qwen-plus 等）。",
                "reasoning": reasoning[:3000],
                "finishReason": payload["finishReason"],
            }
        return None, {
            "status": 502,
            "error": "接口没有返回任何文本内容",
            "detail": payload["raw"][:1500],
        }

    return payload, None


# --------------------------------------------------------------------------
# HTTP 处理器
# --------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "AIPromptStudio/0.1"
    protocol_version = "HTTP/1.1"

    # ---------------- 基础工具 ----------------
    def log_message(self, fmt, *args):  # noqa: A003
        if os.environ.get("APS_VERBOSE"):
            sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def _send(self, status: int, body: bytes, ctype: str, extra=None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, status: int, payload) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8")

    def read_body(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
            return data if isinstance(data, dict) else {"value": data}
        except Exception:
            return {}

    # ---------------- 静态文件 ----------------
    def serve_static(self, path: str) -> None:
        if path in ("", "/"):
            path = "/index.html"
        rel = unquote(path.split("?", 1)[0]).lstrip("/")
        full = os.path.normpath(os.path.join(APP_DIR, rel))
        if not (full == APP_DIR or full.startswith(APP_DIR + os.sep)):
            self.send_json(403, {"error": "禁止访问该路径"})
            return
        if not os.path.isfile(full):
            self.send_json(404, {"error": "文件不存在: %s" % rel})
            return
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in (
            "application/javascript",
            "application/json",
            "image/svg+xml",
        ):
            ctype += "; charset=utf-8"
        with open(full, "rb") as handle:
            body = handle.read()
        self._send(200, body, ctype)

    # ---------------- 路由 ----------------
    def do_GET(self):  # noqa: N802
        route = urlparse(self.path).path
        if route == "/api/health":
            self.send_json(200, {"ok": True, "version": self.server_version})
        elif route == "/api/state":
            self.send_json(
                200,
                {
                    "settings": _deep_merge(default_settings(), read_json(SETTINGS_FILE, {})),
                    "presets": read_json(PRESETS_FILE, {"presets": []}).get("presets", []),
                    "history": read_json(HISTORY_FILE, {"combos": []}).get("combos", []),
                },
            )
        elif route == "/api/tags":
            data, source = load_tags()
            data = dict(data)
            data["source"] = source
            data["canReset"] = source == "user"
            self.send_json(200, data)
        elif route.startswith("/api/"):
            self.send_json(404, {"error": "未知接口: %s" % route})
        else:
            self.serve_static(route)

    do_HEAD = do_GET

    def do_POST(self):  # noqa: N802
        route = urlparse(self.path).path
        payload = self.read_body()

        if route == "/api/settings":
            merged = _deep_merge(
                _deep_merge(default_settings(), read_json(SETTINGS_FILE, {})),
                payload,
            )
            write_json(SETTINGS_FILE, merged)
            self.send_json(200, {"ok": True, "settings": merged})

        elif route == "/api/presets":
            store = read_json(PRESETS_FILE, {"presets": []})
            items = store.get("presets", [])
            action = payload.get("action", "save")
            if action == "save":
                name = (payload.get("name") or "").strip() or "未命名组合"
                entry = {
                    "id": payload.get("id") or ("p_%d" % int(time.time() * 1000)),
                    "name": name,
                    "prompt": payload.get("prompt", ""),
                    "negative": payload.get("negative", ""),
                    "tags": payload.get("tags", []),
                    "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
                }
                items = [item for item in items if item.get("id") != entry["id"]]
                items.insert(0, entry)
            elif action == "delete":
                items = [item for item in items if item.get("id") != payload.get("id")]
            elif action == "replace":
                incoming = payload.get("presets")
                if not isinstance(incoming, list):
                    self.send_json(400, {"error": "presets 必须是数组"})
                    return
                cleaned = []
                for index, item in enumerate(incoming):
                    if not isinstance(item, dict):
                        continue
                    cleaned.append({
                        "id": item.get("id") or ("p_%d_%d" % (int(time.time() * 1000), index)),
                        "name": (str(item.get("name") or "").strip() or "未命名组合"),
                        "prompt": str(item.get("prompt") or ""),
                        "negative": str(item.get("negative") or ""),
                        "tags": item.get("tags") if isinstance(item.get("tags"), list) else [],
                        "updatedAt": str(item.get("updatedAt") or time.strftime("%Y-%m-%d %H:%M:%S")),
                    })
                items = cleaned
            write_json(PRESETS_FILE, {"presets": items})
            self.send_json(200, {"ok": True, "presets": items})

        elif route == "/api/history":
            store = read_json(HISTORY_FILE, {"combos": []})
            combos = [c for c in store.get("combos", []) if isinstance(c, list)]
            combo = payload.get("combo") or []
            if combo:
                combo = sorted(set(str(t) for t in combo))
                combos = [c for c in combos if sorted(set(c)) != combo]
                combos.insert(0, combo)
            write_json(HISTORY_FILE, {"combos": combos[:300]})
            self.send_json(200, {"ok": True, "count": len(combos)})

        elif route == "/api/tags":
            categories = payload.get("categories")
            if not isinstance(categories, list):
                self.send_json(400, {"error": "categories 必须是数组"})
                return
            cleaned, problem = sanitize_tags(categories)
            if problem:
                self.send_json(400, {"error": problem})
                return
            write_json(TAGS_USER_FILE, {"version": 1, "categories": cleaned})
            total = sum(len(g.get("tags", [])) for c in cleaned for g in c.get("groups", []))
            self.send_json(
                200,
                {
                    "ok": True,
                    "source": "user",
                    "categories": cleaned,
                    "stats": {"categories": len(cleaned), "tags": total},
                },
            )

        elif route == "/api/tags/reset":
            if os.path.exists(TAGS_USER_FILE):
                backup = TAGS_USER_FILE + ".bak"
                try:
                    os.replace(TAGS_USER_FILE, backup)
                except OSError:
                    os.remove(TAGS_USER_FILE)
            self.send_json(200, {"ok": True, "source": "builtin", "backup": TAGS_USER_FILE + ".bak"})

        elif route == "/api/vision":
            self.handle_vision(payload)

        elif route == "/api/translate":
            self.handle_translate(payload)

        elif route == "/api/polish":
            self.handle_polish(payload)

        elif route == "/api/test-connection":
            self.handle_test_connection(payload)

        else:
            self.send_json(404, {"error": "未知接口: %s" % route})

    # ---------------- 大模型代理 ----------------
    def resolve_llm_config(self, payload: dict):
        saved = _deep_merge(default_settings(), read_json(SETTINGS_FILE, {}))
        base_url = (payload.get("base_url") or saved.get("base_url") or "").strip()
        api_key = payload.get("api_key") or saved.get("api_key") or ""
        model = payload.get("model") or saved.get("model") or ""
        try:
            timeout = int(payload.get("timeout") or saved.get("timeout") or 90)
        except (TypeError, ValueError):
            timeout = 90
        try:
            max_tokens = int(payload.get("max_tokens") or saved.get("max_tokens") or 8192)
        except (TypeError, ValueError):
            max_tokens = 8192
        max_tokens = max(256, min(65536, max_tokens))
        return base_url, api_key, model, timeout, max_tokens

    def handle_vision(self, payload: dict) -> None:
        base_url, api_key, model, timeout, max_tokens = self.resolve_llm_config(payload)
        saved = _deep_merge(default_settings(), read_json(SETTINGS_FILE, {}))
        image = payload.get("image") or ""
        system_prompt = payload.get("system_prompt") or saved.get("vision_system_prompt")
        user_prompt = payload.get("user_prompt") or saved.get("vision_user_prompt")

        if not image:
            self.send_json(400, {"error": "缺少图片数据"})
            return
        if not base_url or not model:
            self.send_json(400, {"error": "请先在「设置」中填写接口地址与模型名称"})
            return
        if not image.startswith("data:"):
            image = "data:image/png;base64," + image

        body = {
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": user_prompt},
                        {"type": "image_url", "image_url": {"url": image}},
                    ],
                },
            ],
            "temperature": 0.4,
            "max_tokens": max_tokens,
        }

        result, error = call_chat_completion(base_url, api_key, body, timeout)
        if error:
            self.send_json(error.pop("status", 502), error)
            return
        self.send_json(200, {
            "ok": True,
            "content": result["content"],
            "reasoning": result["reasoning"],
            "model": model,
            "url": base_url.rstrip("/") + "/chat/completions",
        })

    def handle_test_connection(self, payload: dict) -> None:
        """体检：验证地址 + Key 能不能通，并检查模型名在不在返回的列表里。"""
        base_url, api_key, model, timeout, _max_tokens = self.resolve_llm_config(payload)

        if not base_url:
            self.send_json(400, {"error": "请先填写接口地址"})
            return

        probe_timeout = max(5, min(timeout, 20))
        models, problem = try_list_models(base_url, api_key, probe_timeout)

        if problem is None:
            found = (model in models) if model else None
            self.send_json(200, {
                "ok": True,
                "method": "models",
                "url": base_url.rstrip("/") + "/models",
                "modelCount": len(models),
                "modelFound": found,
                "sample": models[:20],
                "message": "地址与 API Key 均可用",
            })
            return

        # 有些服务没实现 /models，退一步发一次极小的对话请求
        if problem["status"] in (404, 405, -2) and model:
            probe_body = {
                "model": model,
                "messages": [{"role": "user", "content": "hi"}],
                "max_tokens": 1,
            }
            _result, error = call_chat_completion(base_url, api_key, probe_body, probe_timeout)
            if not error:
                self.send_json(200, {
                    "ok": True,
                    "method": "chat",
                    "url": base_url.rstrip("/") + "/chat/completions",
                    "modelFound": True,
                    "message": "地址、API Key、模型名都可用（该服务没有 /models 接口，用一次最小对话验证的）",
                })
                return
            self.send_json(502, {
                "error": error.get("error", "连接失败"),
                "detail": error.get("detail"),
                "url": error.get("url") or base_url,
            })
            return

        self.send_json(502, {
            "error": friendly_http_error(problem["status"], problem["body"]),
            "detail": problem["body"],
            "url": problem["url"],
        })

    def handle_translate(self, payload: dict) -> None:
        base_url, api_key, model, timeout, max_tokens = self.resolve_llm_config(payload)
        text = (payload.get("text") or "").strip()
        direction = payload.get("direction") or "zh2en"

        if not text:
            self.send_json(400, {"error": "没有需要翻译的内容"})
            return
        if direction not in TRANSLATE_PROMPTS:
            self.send_json(400, {"error": "不支持的翻译方向: %s" % direction})
            return
        if not base_url or not model:
            self.send_json(400, {"error": "请先在「设置」中填写接口地址与模型名称"})
            return

        body = {
            "model": model,
            "messages": [
                {"role": "system", "content": TRANSLATE_PROMPTS[direction]},
                {"role": "user", "content": text},
            ],
            "temperature": 0.2,
            "max_tokens": max_tokens,
        }

        result, error = call_chat_completion(base_url, api_key, body, timeout)
        if error:
            self.send_json(error.pop("status", 502), error)
            return
        self.send_json(200, {
            "ok": True,
            "content": result["content"],
            "reasoning": result["reasoning"],
            "model": model,
            "direction": direction,
        })

    def handle_polish(self, payload: dict) -> None:
        base_url, api_key, model, timeout, max_tokens = self.resolve_llm_config(payload)
        saved = _deep_merge(default_settings(), read_json(SETTINGS_FILE, {}))

        prompt = (payload.get("prompt") or "").strip()
        negative = (payload.get("negative") or "").strip()
        style = payload.get("style") or "balanced"
        target = payload.get("target") or "tags"
        extra = (payload.get("extra") or "").strip()
        suggest_weights = bool(payload.get("suggest_weights"))
        base_system = (payload.get("system_prompt") or saved.get("polish_system_prompt")
                       or DEFAULT_POLISH_SYSTEM_PROMPT)

        if not prompt and not negative:
            self.send_json(400, {"error": "提示词是空的，没有可润色的内容"})
            return
        if style not in POLISH_STYLES:
            self.send_json(400, {"error": "不支持的润色方式: %s" % style})
            return
        if target not in POLISH_TARGETS:
            self.send_json(400, {"error": "不支持的输出目标: %s" % target})
            return
        if not base_url or not model:
            self.send_json(400, {"error": "请先在「设置」中填写接口地址与模型名称"})
            return

        parts = [base_system, POLISH_STYLES[style], POLISH_TARGETS[target]]
        if suggest_weights:
            parts.append(POLISH_WEIGHTS_INSTRUCTION)
        if extra:
            parts.append("【用户的额外要求，优先级最高】\n%s" % extra)
        system_prompt = "\n\n".join(parts)

        user_text = "【当前正向提示词】\n%s\n\n【当前负面提示词】\n%s" % (
            prompt or "（空）",
            negative or "（空）",
        )

        body = {
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_text},
            ],
            "temperature": 0.5,
            "max_tokens": max_tokens,
        }

        result, error = call_chat_completion(base_url, api_key, body, timeout)
        if error:
            self.send_json(error.pop("status", 502), error)
            return
        self.send_json(200, {
            "ok": True,
            "content": result["content"],
            "reasoning": result["reasoning"],
            "model": model,
            "style": style,
            "target": target,
            "suggestWeights": suggest_weights,
        })


# --------------------------------------------------------------------------
# 启动
# --------------------------------------------------------------------------
def pick_port(preferred: int = 8765, attempts: int = 30) -> int:
    for offset in range(attempts):
        port = preferred + offset
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise SystemExit("找不到可用端口")


def lock_file_path() -> str:
    return os.path.join(DATA_DIR, "server.lock")


def running_instance_url():
    """如果同一个数据目录下已经有一个活着的实例，返回它的地址。"""
    try:
        with open(lock_file_path(), "r", encoding="utf-8") as handle:
            info = json.load(handle)
        port = int(info.get("port") or 0)
    except Exception:
        return None
    if port <= 0:
        return None
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.4)
        if probe.connect_ex(("127.0.0.1", port)) == 0:
            return "http://127.0.0.1:%d/" % port
    return None


def write_lock(port: int) -> None:
    try:
        with open(lock_file_path(), "w", encoding="utf-8") as handle:
            json.dump({"port": port, "pid": os.getpid()}, handle)
    except Exception:
        pass


def clear_lock() -> None:
    try:
        os.remove(lock_file_path())
    except Exception:
        pass


def run_webview_window(url: str, server: ThreadingHTTPServer) -> bool:
    """用 pywebview 开一个原生窗口（Windows / Linux 上的首选方案）。

    没装 pywebview、或者它起不来（例如 Windows 缺 WebView2 运行时）时返回 False，
    调用方会退回到 tkinter 状态窗口、再退回浏览器。
    """
    try:
        import webview  # type: ignore
    except Exception:
        return False

    try:
        webview.create_window(
            "AI 文生图提示词工作台",
            url,
            width=1420,
            height=900,
            min_size=(1040, 700),
        )
        webview.start()
        return True
    except Exception as exc:
        print("pywebview 窗口不可用：%s" % exc, file=sys.stderr, flush=True)
        return False


def run_status_window(url: str, server: ThreadingHTTPServer) -> bool:
    """打包成 App 时显示一个小状态窗口。能开窗口返回 True，否则 False。"""
    try:
        import tkinter as tk
    except Exception:
        return False
    try:
        root = tk.Tk()
    except Exception:
        return False

    root.title("AI 文生图提示词工作台")
    root.geometry("432x252")
    root.resizable(False, False)
    try:
        root.attributes("-topmost", True)
        root.after(600, lambda: root.attributes("-topmost", False))
    except Exception:
        pass

    frame = tk.Frame(root, padx=20, pady=16)
    frame.pack(fill="both", expand=True)

    tk.Label(frame, text="服务正在运行", font=("Helvetica", 16, "bold")).pack(anchor="w")
    tk.Label(frame, text="在浏览器里打开下面这个地址：", fg="#666666").pack(anchor="w", pady=(8, 4))

    field = tk.Entry(frame, font=("Menlo", 12), relief="flat", bg="#f0f0f3")
    field.insert(0, url)
    field.configure(state="readonly", readonlybackground="#f0f0f3")
    field.pack(fill="x", ipady=5)

    tk.Label(
        frame,
        text="数据目录：%s" % DATA_DIR,
        fg="#8a8a8a",
        font=("Helvetica", 10),
        wraplength=380,
        justify="left",
    ).pack(anchor="w", pady=(10, 0))

    def quit_app():
        try:
            root.destroy()
        finally:
            threading.Thread(target=server.shutdown, daemon=True).start()

    buttons = tk.Frame(frame)
    buttons.pack(fill="x", pady=(18, 0))
    tk.Button(buttons, text="打开浏览器", width=12,
              command=lambda: webbrowser.open(url)).pack(side="left")

    def open_data_dir():
        try:
            if sys.platform == "darwin":
                os.system('open "%s"' % DATA_DIR)
            elif os.name == "nt":
                os.startfile(DATA_DIR)  # noqa: S606
            else:
                os.system('xdg-open "%s"' % DATA_DIR)
        except Exception:
            pass

    tk.Button(buttons, text="数据目录", width=10, command=open_data_dir).pack(side="left", padx=8)
    tk.Button(buttons, text="退出", width=8, command=quit_app).pack(side="right")

    root.protocol("WM_DELETE_WINDOW", quit_app)
    root.mainloop()
    return True


def redirect_output_to_log() -> None:
    """打包成 App 后没有终端，把输出写到数据目录下的 app.log。"""
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        handle = open(os.path.join(DATA_DIR, "app.log"), "a", encoding="utf-8", buffering=1)
        sys.stdout = handle
        sys.stderr = handle
        print("\n---- %s 启动 ----" % time.strftime("%Y-%m-%d %H:%M:%S"))
    except Exception:
        pass


def watch_parent() -> None:
    """被 App 拉起来时，父进程没了就跟着退出，避免变成孤儿占着端口。"""
    if not is_frozen():
        return
    parent = os.getppid()
    if parent <= 1:
        return

    def loop():
        while True:
            time.sleep(3)
            if os.getppid() != parent or os.getppid() <= 1:
                clear_lock()
                os._exit(0)

    threading.Thread(target=loop, daemon=True).start()


def main() -> None:
    ensure_data_dir()
    if is_frozen():
        redirect_output_to_log()
        watch_parent()

    # 打包成 App 时避免重复启动：已有实例就直接把浏览器指过去
    if is_frozen() and os.environ.get("APS_ALLOW_MULTI") != "1":
        alive = running_instance_url()
        if alive:
            print("已经在运行：%s" % alive, flush=True)
            webbrowser.open(alive)
            return

    port = pick_port(int(os.environ.get("APS_PORT", "8765")))
    url = "http://127.0.0.1:%d/" % port

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    write_lock(port)

    print("=" * 58, flush=True)
    print("  AI 文生图提示词工作台  已启动", flush=True)
    print("  访问地址: %s" % url, flush=True)
    print("  数据目录: %s" % DATA_DIR, flush=True)
    if not is_frozen():
        print("  关闭此窗口即可停止服务", flush=True)
    print("=" * 58, flush=True)

    if os.environ.get("APS_NO_BROWSER") != "1":
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    # 打包成 App：优先开原生窗口，关掉窗口就退出
    if is_frozen() and os.environ.get("APS_NO_WINDOW") != "1":
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()

        # ① pywebview 原生窗口（Windows / Linux 首选；macOS 由 Swift 外壳接管，不会走到这）
        if os.environ.get("APS_FORCE_BROWSER") != "1":
            try:
                if run_webview_window(url, server):
                    clear_lock()
                    server.server_close()
                    return
            except Exception as exc:
                print("pywebview 启动失败：%s" % exc, file=sys.stderr, flush=True)

        # ② tkinter 状态窗口兜底
        used_window = False
        try:
            used_window = run_status_window(url, server)
        except Exception as exc:
            print("状态窗口不可用：%s" % exc, file=sys.stderr, flush=True)
        if used_window:
            clear_lock()
            server.server_close()
            return

        # ③ 什么窗口都开不了：开浏览器，进程留在后台
        print("已改为后台运行，可在「活动监视器」里结束本进程。", file=sys.stderr, flush=True)
        if os.environ.get("APS_NO_BROWSER") == "1":
            webbrowser.open(url)
        try:
            worker.join()
        except KeyboardInterrupt:
            pass
        clear_lock()
        server.server_close()
        return

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        clear_lock()
        server.server_close()


if __name__ == "__main__":
    main()
