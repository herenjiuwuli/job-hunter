"""
「公司名未知」的老记录，能不能被后来的采集结果认领（2026-11-10 真机）。

事故现场：
    库里 75 条 BOSS 记录是「未知公司 + 标题带薪资」（「测试实习生 3-5K」）。
    一键投递建的时候公司名选择器是坏的（class 名全被改版换掉），标题则是页面原文。
    后来从聊天页 / 投递记录页采到的是「公司真名 + 剥了薪资的标题」。
    公司这一半对不上、标题那一半也对不上 → `sameApply` 判不是同一条 → **新建**一条重复，
    而投递日期留在旧记录里 → 界面表现就是「补上公司名的那几条，日期反而没了」。

守的四件事：
    1. 库里有真名 → **不许**只凭标题认领（那是硬证据，对不上就是另一家）；
    2. 库里没公司名 → 允许只凭标题认领，但标题必须**全库唯一**；
    3. 认领后把真公司名订正进去（否则白认，界面还是「未知公司」）；
    4. 投递日期只补不清 —— 空值绝不能冲掉账本里已有的时间。
"""
import requests
from conftest import BASE, auth_headers

PLAT = "BOSS直聘"


def _app(**kw):
    body = {
        "company": "未知公司",
        "jobTitle": "测试实习生 3-5K",
        "platform": PLAT,
        "status": "已投递",
    }
    body.update(kw)
    r = requests.post(f"{BASE}/api/applications", json=body, timeout=10)
    assert r.status_code == 200, r.text
    return r.json()


def _collect(items, create_missing=False):
    payload = {"items": items}
    if create_missing:
        payload["createMissing"] = True
    r = requests.post(
        f"{BASE}/api/applications/collect",
        json=payload,
        headers=auth_headers("owner"),
        timeout=10,
    )
    assert r.status_code == 200, r.text
    return r.json()


def _rows():
    return requests.get(f"{BASE}/api/applications", timeout=10).json()


def test_unknown_company_claimed_by_title():
    """库里那条没公司名 → 后来采到真名就该**认领**，而不是新建一条重复"""
    _app(jobId="boss_x1", appliedAt="2026-11-09T08:00:00.000Z")
    data = _collect(
        [{"platform": PLAT, "company": "视界之外", "jobTitle": "测试实习生"}]  # 无 jobId、无 appliedAt
    )

    rows = _rows()
    assert len(rows) == 1, f"不该新建重复记录：{[(r['company'], r['jobTitle']) for r in rows]}"
    assert data["created"] == 0
    assert rows[0]["company"] == "视界之外", "认领后必须把真名订正进去，否则界面还是「未知公司」"
    assert rows[0]["jobId"] == "boss_x1", "平台主键要留在原记录上"
    assert rows[0]["appliedAt"] == "2026-11-09T08:00:00.000Z", "投递日期不能因为一次同步就没了"


def test_real_company_is_not_claimed_by_title():
    """库里有真名 → 标题再像也不许认领（同一家公司投两个同名岗很常见，认错就是张冠李戴）"""
    _app(company="甲公司", jobTitle="测试实习生", jobId="boss_a1")
    data = _collect([{"platform": PLAT, "company": "乙公司", "jobTitle": "测试实习生"}], create_missing=True)

    rows = _rows()
    assert len(rows) == 2, "两家不同公司必须各记一条"
    assert data["created"] == 1
    assert sorted(r["company"] for r in rows) == ["乙公司", "甲公司"]


def test_ambiguous_title_is_ignored():
    """两条候选都叫「助理测试工程师」且都没公司名 → 认谁都可能错，宁可忽略也不猜"""
    _app(jobTitle="助理测试工程师 120-180元/天", jobId="boss_b1")
    _app(jobTitle="助理测试工程师 9-13K", jobId="boss_b2")

    data = _collect([{"platform": PLAT, "company": "银河电力", "jobTitle": "助理测试工程师"}])

    rows = _rows()
    assert len(rows) == 2, "认不出来就不能建新记录（那只是把重复越堆越多）"
    assert data["ignored"] == 1
    assert "认不出" in data["results"][0]["reason"]


def test_applied_at_never_cleared():
    """采集端读不到投递日期（空串）→ 绝不能把账本里已有的时间冲掉"""
    _app(company="丙公司", jobTitle="测试开发实习生", appliedAt="2026-11-01T02:00:00.000Z")
    _collect([{"platform": PLAT, "company": "丙公司", "jobTitle": "测试开发实习生", "appliedAt": ""}])

    assert _rows()[0]["appliedAt"] == "2026-11-01T02:00:00.000Z"


def test_applied_at_filled_when_missing():
    """账本里没有投递日期、这次采到了 → 补进去（只补不清的另一半）"""
    _app(company="丁公司", jobTitle="测试工程师")
    _collect(
        [
            {
                "platform": PLAT,
                "company": "丁公司",
                "jobTitle": "测试工程师",
                "appliedAt": "2026-11-08T00:00:00.000Z",
            }
        ]
    )
    assert _rows()[0]["appliedAt"] == "2026-11-08T00:00:00.000Z"
