"""鉴权测试：没有 token 一律进不来，token 坏了/过期了也不行。

为什么用表驱动把**所有**接口扫一遍：
  「只给 /api/resumes 加鉴权」是最典型的假安全 —— 漏掉的 /api/backup/export
  一次就能把全部个人数据打包带走。这类漏挂只能是机械扫描发现的，
  靠人眼在 18 个路由文件里数「哪个忘了加中间件」必然出错。
"""
import base64
import hashlib
import hmac
import json
import os
import time
import uuid

import pytest
import requests

from conftest import BASE, DATA_DIR, TOKENS, auth_headers, create_user_via_cli, new_invite

# 全部需要登录的接口：(方法, 路径, 请求体)
# 请求体给最小合法值即可 —— 鉴权在路由之前，401 会先返回，轮不到参数校验
ENDPOINTS = [
    ("GET", "/api/resumes", None),
    ("GET", "/api/resumes/any-id", None),
    ("POST", "/api/resumes", {}),
    ("PUT", "/api/resumes/any-id", {}),
    ("DELETE", "/api/resumes/any-id", None),
    ("GET", "/api/applications", None),
    ("GET", "/api/applications/any-id", None),
    ("POST", "/api/applications", {}),
    ("PUT", "/api/applications/any-id", {}),
    ("DELETE", "/api/applications/any-id", None),
    ("POST", "/api/applications/collect", {"items": []}),
    ("GET", "/api/funnel", None),
    ("GET", "/api/funnel?groupBy=direction", None),
    ("GET", "/api/records", None),
    ("GET", "/api/records/any-id", None),
    ("POST", "/api/records", {}),
    ("DELETE", "/api/records/any-id", None),
    ("GET", "/api/profile", None),
    ("PUT", "/api/profile", {}),
    ("GET", "/api/dashboard", None),
    ("GET", "/api/backup/export", None),
    ("POST", "/api/backup/import", {}),
    ("GET", "/api/match?resumeId=x", None),
    ("POST", "/api/match/jd", {}),
    ("POST", "/api/match/analyze", {}),
    ("POST", "/api/tailor", {}),
    ("POST", "/api/analyze", {}),
    ("POST", "/api/apply/assist", {}),
    ("POST", "/api/ammo", {}),
    ("POST", "/api/interview/start", {}),
    ("POST", "/api/interview/answer", {}),
    ("POST", "/api/interview/report", {}),
    ("POST", "/api/interview/predict", {}),
    ("POST", "/api/intro/practice", {}),
    ("POST", "/api/prep/checklist", {}),
    ("POST", "/api/salary/start", {}),
    ("POST", "/api/salary/answer", {}),
    ("POST", "/api/salary/report", {}),
    ("POST", "/api/resume/generate", {}),
    ("POST", "/api/resume/score", {}),
    ("POST", "/api/resume/export", {}),
    ("POST", "/api/resume/import", {}),
    # 邀请码管理是 owner 的权限，但「未登录」这一层必须先在闸门外被挡住（401 而不是 403）
    ("GET", "/api/auth/invites", None),
    ("POST", "/api/auth/invites", {}),
    ("DELETE", "/api/auth/invites/ABCD-EFGH-JKLM", None),
]

IDS = [f"{m} {p.split('?')[0]}" for m, p, _ in ENDPOINTS]


def _no_auth():
    """
    模拟「完全没带 token」。

    conftest 会给所有请求默认注入 owner 的 token；这里显式传一个空的
    Authorization 头（键存在、值为空），注入逻辑就不会覆盖它，
    到后端等价于「没带」——req.get('authorization') 是空串。
    """
    return {"Authorization": ""}


@pytest.mark.parametrize("method,path,body", ENDPOINTS, ids=IDS)
def test_endpoint_requires_auth(method, path, body):
    r = requests.request(method, f"{BASE}{path}", json=body, headers=_no_auth(), timeout=10)
    assert r.status_code == 401, f"{method} {path} 未登录竟然返回 {r.status_code}：{r.text[:200]}"


def test_health_is_public():
    """/api/health 必须免登录，否则前端连「后端活没活」都探不到"""
    r = requests.get(f"{BASE}/api/health", headers=_no_auth(), timeout=10)
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


@pytest.mark.parametrize(
    "header",
    ["Bearer not-a-token", "Bearer a.b.c", "token-without-bearer", "Bearer "],
    ids=["垃圾串", "三段伪造", "缺 Bearer 前缀", "空 token"],
)
def test_bad_token_rejected(header):
    r = requests.get(f"{BASE}/api/resumes", headers={"Authorization": header}, timeout=10)
    assert r.status_code == 401


def _secret():
    if os.environ.get("JWT_SECRET"):
        return os.environ["JWT_SECRET"]
    p = os.path.join(DATA_DIR, ".jwt-secret")
    if not os.path.exists(p):
        pytest.skip("找不到签名密钥文件，跳过签名相关用例")
    with open(p, encoding="utf-8") as f:
        return f.read().strip()


def _b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _forge(payload: dict) -> str:
    """用真实密钥自签一个 token —— 用来证明后端真的在校验 exp 和签名"""
    header = _b64u(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    body = _b64u(json.dumps(payload).encode())
    sig = _b64u(hmac.new(_secret().encode(), f"{header}.{body}".encode(), hashlib.sha256).digest())
    return f"{header}.{body}.{sig}"


def _my_id():
    r = requests.get(f"{BASE}/api/auth/me", timeout=10)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_expired_token_rejected():
    """签名完全正确但已过期 → 必须 401。不校验 exp 的 token 等于永久通行证"""
    now = int(time.time())
    tok = _forge({"sub": _my_id(), "iat": now - 7200, "exp": now - 3600})
    r = requests.get(f"{BASE}/api/resumes", headers={"Authorization": f"Bearer {tok}"}, timeout=10)
    assert r.status_code == 401


def test_tampered_payload_rejected():
    """改 payload 不改签名 → 必须 401（这就是「不能自己给自己发管理员」的保证）"""
    tok = TOKENS["owner"]
    head, _, sig = tok.split(".")
    evil = _b64u(json.dumps({"sub": "u_admin", "exp": int(time.time()) + 3600}).encode())
    r = requests.get(f"{BASE}/api/resumes", headers={"Authorization": f"Bearer {head}.{evil}.{sig}"}, timeout=10)
    assert r.status_code == 401


def test_valid_token_works():
    r = requests.get(f"{BASE}/api/resumes", headers=auth_headers("owner"), timeout=10)
    assert r.status_code == 200


def test_me_returns_identity():
    r = requests.get(f"{BASE}/api/auth/me", headers=auth_headers("owner"), timeout=10)
    assert r.status_code == 200
    assert r.json()["username"] == "owner_test"
    assert r.json()["id"].startswith("u_")


def test_register_duplicate_conflict():
    """用户名重复 → 409。邀请制之后必须先过邀请码这一关，才能撞到重名"""
    code = new_invite()
    assert code, "owner 生成邀请码失败"
    r = requests.post(
        f"{BASE}/api/auth/register",
        json={"username": "owner_test", "password": "whatever-123", "inviteCode": code},
        headers=_no_auth(),
        timeout=10,
    )
    assert r.status_code == 409


def test_register_short_password():
    code = new_invite()
    assert code, "owner 生成邀请码失败"
    r = requests.post(
        f"{BASE}/api/auth/register",
        json={"username": "shortpw_test", "password": "123", "inviteCode": code},
        headers=_no_auth(),
        timeout=10,
    )
    assert r.status_code == 400


def test_login_wrong_password():
    """
    已存在的账号 + 错误口令 → 401。

    账号用命令行脚本一次性造（不经过注册接口、不用消耗邀请码），
    且名字随机：错误登录会累积失败计数，拿公共账号去撞等于给后面所有用例埋雷。
    """
    name = f"wrongpw_{uuid.uuid4().hex[:8]}"
    assert create_user_via_cli({"username": name, "password": "right-password-123"}), "脚本建号失败"
    r = requests.post(
        f"{BASE}/api/auth/login",
        json={"username": name, "password": "definitely-wrong"},
        headers=_no_auth(),
        timeout=10,
    )
    assert r.status_code == 401


def test_login_unknown_user_same_message():
    """
    用户不存在和密码错误必须给同一个响应，否则可被用来枚举账号。

    用户名带随机后缀：登录失败计数在**服务端内存里跨 pytest 运行保留**，
    用固定名字跑 5 轮就会把自己锁成 429，变成一条会自己烂掉的用例。
    """
    r = requests.post(
        f"{BASE}/api/auth/login",
        json={"username": f"no-such-user-{uuid.uuid4().hex[:8]}", "password": "irrelevant"},
        headers=_no_auth(),
        timeout=10,
    )
    assert r.status_code == 401
    assert "用户名或密码错误" in r.json().get("error", "")


def test_unauthenticated_write_does_not_persist():
    """401 必须发生在写文件之前 —— 否则「拒绝」只是嘴上说说"""
    requests.post(f"{BASE}/api/resumes", json={"title": "偷写"}, headers=_no_auth(), timeout=10)
    r = requests.get(f"{BASE}/api/resumes", timeout=10)
    assert r.json() == []


def test_lockout_after_repeated_failures():
    """
    连续失败 5 次后锁 10 分钟，挡住脚本撞库。

    账号用命令行脚本造、名字带随机后缀：限速计数在服务端内存里、
    跨 pytest 运行保留 10 分钟，用固定名字会「上一轮把这一轮锁住了」，
    变成一条自己会红的用例。
    """
    name = f"lockme_{uuid.uuid4().hex[:8]}"
    assert create_user_via_cli({"username": name, "password": "lockme-123456"}), "脚本建号失败"

    bad = {"username": name, "password": "wrong-pw"}
    codes = [
        requests.post(f"{BASE}/api/auth/login", json=bad, headers=_no_auth(), timeout=10).status_code
        for _ in range(6)
    ]
    assert codes[:5] == [401] * 5, f"前 5 次应为普通失败：{codes}"
    assert codes[5] == 429, f"第 6 次没有限速：{codes}"
