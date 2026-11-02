"""越权（水平越权 / IDOR）测试：登录了也不等于能看到别人的数据。

核心断言：B 拿着自己的合法 token 去请求 A 的资源 → 404（不是 403）。
为什么刻意用 404 不用 403：403 等于告诉攻击者「这个 id 真的存在，只是不给你」，
配合遍历 id 就能扫出别人的数据有多少。对跨用户访问，正确答案是「假装没有」。

覆盖的不只是 CRUD —— 只要有一个读接口没做过滤，攻击者就能从那里把数据捞完：
dashboard（聚合数）、backup/export（全量打包）、match/analyze（按 resumeId 取简历）。
"""
import pytest
import requests

from conftest import BASE, auth_headers


def A():
    return auth_headers("owner")


def B():
    return auth_headers("intruder")


def _id_of(who):
    r = requests.get(f"{BASE}/api/auth/me", headers=who, timeout=10)
    assert r.status_code == 200, r.text
    return r.json()["id"]


PATHS = {
    "resume": "/api/resumes",
    "application": "/api/applications",
    "record": "/api/records",
}


def _create(kind, headers, **override):
    """按类型在各路由建一条资源，返回完整对象"""
    if kind == "resume":
        body = {"title": "我的简历", "basic": {"name": "晨"}, "skills": ["Vue3"]}
    elif kind == "application":
        body = {"company": "某公司", "jobTitle": "测试开发实习", "jd": "要求熟悉 pytest"}
    elif kind == "record":
        body = {"job": {"title": "测试开发实习"}, "questions": 3, "report": {"totalScore": 80}}
    else:
        raise ValueError(kind)
    body.update(override)
    r = requests.post(f"{BASE}{PATHS[kind]}", json=body, headers=headers, timeout=10)
    assert r.status_code == 200, f"创建 {kind} 失败：{r.status_code} {r.text[:200]}"
    return r.json()


# ---------- 读：列表与详情 ----------


@pytest.mark.parametrize("kind", ["resume", "application", "record"])
def test_list_only_shows_own(kind):
    mine = _create(kind, A(), title="A的", company="A公司")
    r = requests.get(f"{BASE}{PATHS[kind]}", headers=B(), timeout=10)
    assert r.status_code == 200
    assert all(x["id"] != mine["id"] for x in r.json()), f"B 的 {kind} 列表里出现了 A 的数据"


@pytest.mark.parametrize("kind", ["resume", "application", "record"])
def test_get_other_returns_404(kind):
    mine = _create(kind, A(), title="A的", company="A公司")
    r = requests.get(f"{BASE}{PATHS[kind]}/{mine['id']}", headers=B(), timeout=10)
    assert r.status_code == 404, f"B 拿到了 A 的 {kind}：{r.status_code} {r.text[:200]}"


@pytest.mark.parametrize("kind", ["resume", "application"])  # records 没有 PUT 路由，不在此列
def test_update_other_returns_404_and_keeps_data(kind):
    mine = _create(kind, A(), title="原标题", company="A公司")
    r = requests.put(f"{BASE}{PATHS[kind]}/{mine['id']}", json={"title": "被B改了"}, headers=B(), timeout=10)
    assert r.status_code == 404
    # 确认真的没被改
    back = requests.get(f"{BASE}{PATHS[kind]}/{mine['id']}", headers=A(), timeout=10)
    assert back.status_code == 200
    assert back.json().get("title") != "被B改了"


@pytest.mark.parametrize("kind", ["resume", "application", "record"])
def test_delete_other_returns_404_and_keeps_data(kind):
    mine = _create(kind, A(), title="要保留", company="A公司")
    r = requests.delete(f"{BASE}{PATHS[kind]}/{mine['id']}", headers=B(), timeout=10)
    assert r.status_code == 404
    assert requests.get(f"{BASE}{PATHS[kind]}/{mine['id']}", headers=A(), timeout=10).status_code == 200


# ---------- 聚合读：三条最容易漏的「后门」 ----------


def test_dashboard_counts_only_own():
    _create("resume", A())
    _create("application", A())
    _create("record", A())
    r = requests.get(f"{BASE}/api/dashboard", headers=B(), timeout=10)
    assert r.status_code == 200
    c = r.json()["counts"]
    assert c["resumes"] == 0 and c["applications"] == 0 and c["records"] == 0, f"B 的总览统计到了 A 的数据：{c}"


def test_backup_export_only_own():
    _create("resume", A())
    _create("application", A())
    r = requests.get(f"{BASE}/api/backup/export", headers=B(), timeout=10)
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["resumes"] == [], "B 的备份导出里含 A 的简历"
    assert data["applications"] == [], "B 的备份导出里含 A 的投递"


def test_match_analyze_cannot_use_other_resume():
    resume = _create("resume", A())
    app = _create("application", A())
    r = requests.post(
        f"{BASE}/api/match/analyze",
        json={"resumeId": resume["id"], "applicationId": app["id"]},
        headers=B(),
        timeout=10,
    )
    assert r.status_code == 404, f"B 用 A 的简历做匹配分析竟然通过：{r.status_code} {r.text[:200]}"


def test_match_jd_cannot_fall_back_to_other_resume():
    """
    /api/match/jd 老逻辑是「resumeId 找不到就用简历库第一份」——
    多用户下这等于：B 随便传个不存在的 id，就能拿到 A 简历的打分结果。
    """
    a_resume = _create("resume", A(), title="A的简历")
    r = requests.post(
        f"{BASE}/api/match/jd",
        json={"resumeId": a_resume["id"], "jdText": "熟悉 Vue3 与 Node.js"},
        headers=B(),
        timeout=10,
    )
    assert r.status_code in (404, 400), f"B 通过 match/jd 读到了 A 的简历：{r.status_code} {r.text[:200]}"


# ---------- 画像：单人对象 → 每人一份 ----------


def test_profile_is_per_user():
    requests.put(f"{BASE}/api/profile", json={"basic": {"name": "A的画像"}}, headers=A(), timeout=10)
    requests.put(f"{BASE}/api/profile", json={"basic": {"name": "B的画像"}}, headers=B(), timeout=10)

    a = requests.get(f"{BASE}/api/profile", headers=A(), timeout=10).json()
    b = requests.get(f"{BASE}/api/profile", headers=B(), timeout=10).json()
    assert a["basic"]["name"] == "A的画像", f"A 的画像被串了：{a['basic']}"
    assert b["basic"]["name"] == "B的画像", f"B 的画像被串了：{b['basic']}"


# ---------- 写：不能自己指定 ownerId（批量赋值漏洞） ----------


@pytest.mark.parametrize("kind", ["resume", "application", "record"])
def test_cannot_forge_owner_id_on_create(kind):
    """请求体里塞 ownerId 想把数据直接写进别人名下 → 必须被后端覆盖为自己的 id"""
    a_id = _id_of(A())
    b_id = _id_of(B())
    obj = _create(kind, B(), title="投毒", company="投毒公司", ownerId=a_id)

    # /api/records 的 POST 只返回 {id}，得再查一次才能看到归属
    stored = obj if obj.get("ownerId") is not None else requests.get(
        f"{BASE}{PATHS[kind]}/{obj['id']}", headers=B(), timeout=10
    ).json()
    assert stored.get("ownerId") == b_id, f"{kind} 的 ownerId 被客户端指定了：{stored.get('ownerId')}"

    # A 那边不应该多出这条
    lst = requests.get(f"{BASE}{PATHS[kind]}", headers=A(), timeout=10).json()
    assert all(x["id"] != obj["id"] for x in lst)


def test_backup_import_cannot_inject_into_others_namespace():
    """
    备份导入是最容易被忽略的写入通道：它直接把整个 JSON 覆盖写回。
    如果导入时不重置 ownerId，B 导入一份自己改过的备份就能往 A 名下塞数据。
    """
    mine = _create("resume", A(), title="A的简历")
    exported = requests.get(f"{BASE}/api/backup/export", headers=A(), timeout=10).json()

    a_id = _id_of(A())
    b_id = _id_of(B())
    # B 原样导入 A 的备份
    r = requests.post(f"{BASE}/api/backup/import", json=exported, headers=B(), timeout=10)
    assert r.status_code == 200

    b_list = requests.get(f"{BASE}/api/resumes", headers=B(), timeout=10).json()
    assert all(x["ownerId"] == b_id for x in b_list), "导入后 B 名下的记录 ownerId 不是 B"

    a_list = requests.get(f"{BASE}/api/resumes", headers=A(), timeout=10).json()
    ids = [x["id"] for x in a_list]
    assert ids == [mine["id"]], f"A 的简历被导入污染：{[ (x['id'], x.get('ownerId')) for x in a_list ]}"
