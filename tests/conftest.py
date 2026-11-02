"""pytest 全局配置：
1. 会话前置检查：强制 mock AI + 隔离数据目录，防止误打真实 API / 污染真实数据。
2. 会话前置登录：准备两个测试账号（owner / intruder），并把 owner 的 token
   注入到所有 requests 调用里 —— 这样 61 个老用例不用逐个改签名，
   而越权用例可以显式传 headers 覆写，用 intruder 的身份去撞。
3. 每个测试函数前后清空运行时数据，保证测试隔离、可重复跑。

只清「运行时数据」，保留 jobs.json（岗位知识库，apply/interview 测试依赖它）和
users.json（删了 token 就失效，而且老用例会全部 401）。

⚠️ 邀请制之后「注册接口」不能再用来准备测试账号（必须带邀请码）。
   所以账号准备改走 scripts/create-user.mjs —— 命令行工具，不引入测试专用后门。
"""
import os
import shutil
import subprocess
import pytest
import requests

BASE = os.environ.get("JH_BASE", "http://localhost:3100")

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
CREATE_USER = os.path.join(ROOT, 'scripts', 'create-user.mjs')

# 数据目录与后端 store.js 逻辑保持一致：JOB_HUNTER_DATA_DIR 优先（测试隔离）
DATA_DIR = os.environ.get("JOB_HUNTER_DATA_DIR") or os.path.join(
    os.path.dirname(__file__), '..', 'server', 'data'
)

# 运行时数据文件（可清）；jobs.json 是知识库、users.json 是账号，都不清。
# invites.json 清掉是有意的：每个用例从「没有任何邀请码」开始，用例之间不会互相看到码。
RUNTIME_FILES = ('resumes.json', 'applications.json', 'records.json', 'profile.json', 'invites.json')

# 两个固定测试账号：owner = 数据的主人（能发邀请码），intruder = 用来撞别人数据的坏人
OWNER = {"username": "owner_test", "password": "owner-test-pw"}
INTRUDER = {"username": "intruder_test", "password": "intruder-test-pw"}

# username -> token。测试文件通过 conftest.auth_headers("intruder") 取
TOKENS = {}


def auth_headers(who="owner"):
    """取某个测试账号的请求头。没登录成功时返回空 dict（让用例自然跑红）。"""
    tok = TOKENS.get(who)
    return {"Authorization": f"Bearer {tok}"} if tok else {}


def new_invite(headers=None, **body):
    """
    让 owner 生成一个邀请码，返回展示形式（ABCD-EFGH-JKLM）；失败返回空串。

    邀请制之后，除了「全新部署的首个账号」，任何注册都必须带码。
    测试里造码是高频动作，抽在这里，用例只关心「拿这个码去注册会怎样」。
    """
    h = auth_headers("owner") if headers is None else headers
    r = requests.post(f"{BASE}/api/auth/invites", json=body, headers=h, timeout=10)
    if r.status_code != 200:
        return ""
    return r.json().get("code") or ""


def _clear():
    for name in RUNTIME_FILES:
        p = os.path.join(DATA_DIR, name)
        if os.path.exists(p):
            os.remove(p)


@pytest.fixture(autouse=True)
def clean_runtime_data():
    _clear()
    yield
    _clear()


def _login(creds):
    try:
        r = requests.post(f"{BASE}/api/auth/login", json=creds, timeout=10)
        if r.status_code == 200:
            return r.json().get("token")
    except Exception:
        pass
    return None


def create_user_via_cli(creds, role="member"):
    """
    用运维脚本建账号（已存在则重置密码 + 设定角色），返回是否成功。

    为什么不用 POST /api/auth/register：
      邀请制之后注册必须带有效邀请码，而「准备测试账号」是跑用例的前提，
      不能反过来依赖被测功能。也不给注册接口开「测试模式」开关 ——
      那种后门一旦忘了关就是真漏洞。

    测试自己也用它来造「已存在的账号」（比如测登录失败限速），
    就不用为了准备一个账号先去邀请一轮。
    """
    node = shutil.which("node") or shutil.which("node.exe")
    if not node:
        return False
    try:
        p = subprocess.run(
            [node, CREATE_USER, "--username", creds["username"], "--password", creds["password"],
             "--role", role, "--reset", "--data", DATA_DIR],
            capture_output=True, text=True, timeout=60,
        )
        return p.returncode == 0
    except Exception:
        return False


def _prepare_account(key, creds, role):
    """优先登录；登录不上就建号/重置，再登录。返回 token 或 None"""
    tok = _login(creds)
    if tok:
        # 账号已存在但角色可能不对（老库里的账号没有 role 字段），照样纠正一次
        create_user_via_cli(creds, role)
        return _login(creds)
    if not create_user_via_cli(creds, role):
        return None
    return _login(creds)


def _install_default_auth():
    """
    把 owner 的 token 设为 requests 的默认请求头。

    为什么改 Session.request 而不是给每个用例加 fixture：
      61 个老用例全是 requests.post/get 裸调用，逐个加 headers 是 200+ 处机械改动，
      噪音会盖住真正的 diff。这里只在一处注入默认身份，用例想换身份就显式传 headers。

    为什么要判断「已存在 Authorization」：
      越权用例正是靠显式传 intruder 的 header 来覆写，不能无条件覆盖。
    """
    TOKENS["owner"] = _prepare_account("owner", OWNER, "owner")
    TOKENS["intruder"] = _prepare_account("intruder", INTRUDER, "member")

    if not TOKENS.get("owner"):
        return  # 鉴权接口还没实现：不阻断，让相关用例以「未登录」状态跑红

    orig = requests.sessions.Session.request
    if getattr(orig, "_jh_patched", False):
        return

    def patched(self, method, url, **kw):
        headers = dict(kw.get("headers") or {})
        if "Authorization" not in headers and TOKENS.get("owner"):
            headers["Authorization"] = f"Bearer {TOKENS['owner']}"
        kw["headers"] = headers
        return orig(self, method, url, **kw)

    patched._jh_patched = True
    requests.sessions.Session.request = patched


def _check_test_env():
    """会话开始前确认后端是「mock AI + 隔离数据目录」，否则终止整个会话（不执行任何用例）。"""
    try:
        h = requests.get(f"{BASE}/api/health", timeout=5).json()
    except Exception as e:
        pytest.exit(
            f"后端不可达 {BASE}: {e}\n请按 TESTING.md 启动「mock + 隔离数据目录」的后端",
            returncode=1,
        )
    if h.get("aiMock") is not True:
        pytest.exit(
            f"当前后端连的是真实 AI（会花钱且结果不稳定）：{h}\n"
            "请用 DEEPSEEK_BASE_URL=http://127.0.0.1:9999 启动后端",
            returncode=1,
        )
    if h.get("dataDirIsolated") is not True:
        pytest.exit(
            f"当前后端未隔离数据目录（会污染真实数据）：{h}\n"
            "请用 JOB_HUNTER_DATA_DIR=<临时目录> 启动后端",
            returncode=1,
        )
    # 防误删：pytest 进程必须与后端用同一隔离目录，否则下方 clean_runtime_data 会清错地方
    if not os.environ.get("JOB_HUNTER_DATA_DIR"):
        pytest.exit(
            "pytest 进程未设置 JOB_HUNTER_DATA_DIR：运行时数据清理将误删真实 server/data/。\n"
            "请用与后端相同的 JOB_HUNTER_DATA_DIR 环境变量启动 pytest（见 TESTING.md）",
            returncode=1,
        )


def pytest_sessionstart(session):
    _check_test_env()
    _install_default_auth()
