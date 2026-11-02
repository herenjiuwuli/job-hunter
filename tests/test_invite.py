"""邀请制测试：没有有效邀请码，注册这条门就是关着的。

为什么邀请制值得单独一套用例：
  注册是唯一一个「不需要登录就能创建账号」的入口。一旦它有缝，
  后面所有 ownerId 隔离都没意义 —— 攻击者先注册进来，再谈越权。
  所以这里覆盖的不只是「带码能注册」，更是「没码、废码、用过的码、
  过期的码、撤销的码、以及并发抢同一个码」这些失败路径。

顺带定住几条产品约束：
  - 只有 owner 能发码（member 发不了，否则邀请制变成病毒式扩散）
  - 码一次性（用过即失效，不能一个码拉一群人）
  - 注册失败不能白烧码（用户名重名退回码，用户改个名字还能用同一张）
"""
import json
import os
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
import requests

from conftest import BASE, DATA_DIR, auth_headers, new_invite

INVITES_FILE = os.path.join(DATA_DIR, "invites.json")

# 与 server/lib/invites.js 的字母表一致（无 I O 0 1，避免手抄看错）
ALPHABET = set("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")


def _no_auth():
    """显式传空 Authorization：挡住 conftest 的默认 token 注入"""
    return {"Authorization": ""}


def _rand(prefix):
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def _register(username, password="reg-pw-123456", code=None):
    body = {"username": username, "password": password}
    if code is not None:
        body["inviteCode"] = code
    return requests.post(f"{BASE}/api/auth/register", json=body, headers=_no_auth(), timeout=10)


def _read_invites():
    if not os.path.exists(INVITES_FILE):
        return []
    with open(INVITES_FILE, encoding="utf-8") as f:
        return json.load(f)


def _write_invites(items):
    with open(INVITES_FILE, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)


def _expire(formatted_code):
    """把某个码的过期时间改到过去 —— 唯一能立刻造出「过期码」的办法（ttl 最小 1 天）"""
    raw = formatted_code.replace("-", "")
    items = _read_invites()
    hit = False
    for it in items:
        if it.get("code") == raw:
            it["expiresAt"] = "2020-01-01T00:00:00.000Z"
            hit = True
    assert hit, f"invites.json 里找不到 {raw}，夹具没生效"
    _write_invites(items)


# ---------- 主路径 ----------

def test_register_without_invite_rejected():
    """不带邀请码 → 403。这是整个邀请制的底线，破了后面全白做"""
    r = _register(_rand("noinv"))
    assert r.status_code == 403, f"无邀请码竟然注册成功：{r.status_code} {r.text[:200]}"
    assert "邀请" in r.json().get("error", "")


def test_register_with_valid_invite_works():
    """带有效码 → 建号成功，拿到的 token 真的能用，角色是 member"""
    code = new_invite(note="测试用")
    assert code, "owner 生成邀请码失败"
    name = _rand("invited")

    r = _register(name, code=code)
    assert r.status_code == 200, r.text[:200]
    body = r.json()
    assert body["user"]["username"] == name
    assert body["user"]["role"] == "member", "被邀请进来的人不该是 owner"
    assert body["token"]

    me = requests.get(
        f"{BASE}/api/auth/me", headers={"Authorization": f"Bearer {body['token']}"}, timeout=10
    )
    assert me.status_code == 200
    assert me.json()["username"] == name


def test_invite_is_single_use():
    """一个码只能用一次：同码第二次注册必须被拒"""
    code = new_invite()
    first = _register(_rand("once1"), code=code)
    assert first.status_code == 200
    second = _register(_rand("once2"), code=code)
    assert second.status_code == 403, "同一个邀请码被用了两次"


def test_code_accepts_lowercase_and_missing_dashes():
    """手抄场景：小写、去掉横线也要能用（归一化在服务端做）"""
    code = new_invite()
    loose = code.replace("-", "").lower()
    r = _register(_rand("loose"), code=loose)
    assert r.status_code == 200, f"归一化没生效：{r.text[:200]}"


# ---------- 失败路径 ----------

@pytest.mark.parametrize(
    "code",
    ["AAAA-BBBB-CCCC", "test", "", "   ", "ABCD-EFGH-JKL"],
    ids=["形状对但不存在", "乱写", "空串", "空格", "差一位"],
)
def test_bad_code_rejected(code):
    r = _register(_rand("bad"), code=code)
    assert r.status_code == 403


def test_expired_invite_rejected():
    code = new_invite()
    _expire(code)
    r = _register(_rand("exp"), code=code)
    assert r.status_code == 403, "过期码还能用"


def test_revoked_invite_rejected():
    code = new_invite()
    d = requests.delete(f"{BASE}/api/auth/invites/{code}", headers=auth_headers("owner"), timeout=10)
    assert d.status_code == 200, d.text[:200]
    r = _register(_rand("rev"), code=code)
    assert r.status_code == 403, "已撤销的码还能用"


def test_revoke_used_invite_rejected():
    """用过的码不能撤销：它是「谁邀请了谁」的唯一凭证，删了就查不出来"""
    code = new_invite()
    assert _register(_rand("used"), code=code).status_code == 200
    d = requests.delete(f"{BASE}/api/auth/invites/{code}", headers=auth_headers("owner"), timeout=10)
    assert d.status_code == 400


# ---------- 权限 ----------

@pytest.mark.parametrize(
    "method,path",
    [
        ("POST", "/api/auth/invites"),
        ("GET", "/api/auth/invites"),
        ("DELETE", "/api/auth/invites/ABCD-EFGH-JKLM"),
    ],
    ids=["生成", "列表", "撤销"],
)
def test_member_cannot_manage_invites(method, path):
    """
    普通成员不能发码 / 看码 / 撤销。
    要放权就改 lib/auth.js 的 requireOwner 一处，别散落到各路由。
    """
    r = requests.request(method, f"{BASE}{path}", json={}, headers=auth_headers("intruder"), timeout=10)
    assert r.status_code == 403, f"{method} {path} 普通成员竟然能操作：{r.status_code}"


# ---------- 列表与状态 ----------

def test_list_shows_status_and_who_used_it():
    """列表要能看出：哪些还没用、哪些被谁用掉了"""
    code_unused = new_invite(note="还没发出去")
    code_used = new_invite(note="给小王")
    name = _rand("consumer")
    assert _register(name, code=code_used).status_code == 200

    r = requests.get(f"{BASE}/api/auth/invites", headers=auth_headers("owner"), timeout=10)
    assert r.status_code == 200
    items = {i["code"]: i for i in r.json()}

    assert items[code_unused]["status"] == "unused"
    assert items[code_unused]["note"] == "还没发出去"
    assert items[code_used]["status"] == "used"
    assert items[code_used]["usedBy"] == name, f"列表没记录是谁用掉的：{items[code_used]}"


def test_public_check_endpoint():
    """注册页边输边校验用：只回 usable 布尔，不泄露别的"""
    code = new_invite()
    ok = requests.get(f"{BASE}/api/auth/invite/{code}", headers=_no_auth(), timeout=10)
    assert ok.status_code == 200
    assert ok.json()["usable"] is True

    assert _register(_rand("chk"), code=code).status_code == 200
    after = requests.get(f"{BASE}/api/auth/invite/{code}", headers=_no_auth(), timeout=10)
    assert after.json()["usable"] is False

    junk = requests.get(f"{BASE}/api/auth/invite/AAAA-BBBB-CCCC", headers=_no_auth(), timeout=10)
    assert junk.json()["usable"] is False


def test_codes_are_unique_and_avoid_confusable_chars():
    """码的形状约束：12 位、只用无歧义字母表、批量生成不重复"""
    codes = [new_invite() for _ in range(10)]
    assert all(codes), "有码没生成出来"
    assert len(set(codes)) == len(codes), f"出现重复码：{codes}"
    for c in codes:
        raw = c.replace("-", "")
        assert len(raw) == 12, f"{c} 长度不是 12"
        assert set(raw) <= ALPHABET, f"{c} 含字母表外的字符（I/O/0/1 这类易混字符）"


# ---------- 失败不能白烧码 ----------

def test_duplicate_username_returns_the_invite():
    """
    用户名重名 → 409，并且这张码要退回去。
    不退的话，用户「手滑输了个已存在的名字」就白丢一张邀请码，体验上像被骗。
    """
    code = new_invite()
    r = _register("owner_test", code=code)  # owner_test 一定已存在
    assert r.status_code == 409

    chk = requests.get(f"{BASE}/api/auth/invite/{code}", headers=_no_auth(), timeout=10)
    assert chk.json()["usable"] is True, "注册失败后邀请码没退回，白烧了一张"

    # 换一个名字，同一张码还能用
    assert _register(_rand("retry"), code=code).status_code == 200


def test_short_password_returns_the_invite():
    code = new_invite()
    r = _register(_rand("shortpw"), password="123", code=code)
    assert r.status_code == 400
    chk = requests.get(f"{BASE}/api/auth/invite/{code}", headers=_no_auth(), timeout=10)
    assert chk.json()["usable"] is True, "密码太短被拒后，邀请码也没退回来"


# ---------- 并发 ----------

def test_concurrent_same_invite_only_one_wins():
    """
    5 个请求同时抢同一个码 → 只能有 1 个成功。

    这是「校验码 / 建账号 / 占码」三步必须串行的理由：分开做的话，
    每个请求都读到「码还没用过」，于是都通过，最后建出 5 个账号而码只用了一次。
    """
    code = new_invite()
    names = [_rand(f"race{i}") for i in range(5)]

    def attempt(name):
        return _register(name, code=code).status_code

    with ThreadPoolExecutor(max_workers=5) as pool:
        results = list(pool.map(attempt, names))

    assert results.count(200) == 1, f"同一个码成功注册了 {results.count(200)} 次：{results}"
    assert results.count(403) == 4, f"其余应当全部被拒：{results}"

    # 落地的账号也只能多一个：能被登录的应该恰好一个
    logged_in = []
    for name in names:
        r = requests.post(
            f"{BASE}/api/auth/login",
            json={"username": name, "password": "reg-pw-123456"},
            headers=_no_auth(),
            timeout=10,
        )
        if r.status_code == 200:
            logged_in.append(name)
    assert len(logged_in) == 1, f"并发注册留下了多个账号：{logged_in}"
