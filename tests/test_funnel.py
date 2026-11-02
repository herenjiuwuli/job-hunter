"""
投递阶段（stage）与漏斗接口的契约测试。

这组用例守的是三条业务规则，不是「接口能返回 200」：
  1. 阶段只前进（平台页面时序不可靠，回退一次整个漏斗就脏了）
  2. 已读/已回复只记首次时间（否则「平均多久被查看」永远等于最后同步时间）
  3. 漏斗的层数是「到达过」不是「此刻停在这」（否则画出来是分布图不是漏斗）

数据隔离另有一条：B 调 collect 不能推进 A 的记录。
"""
import requests
import pytest
from conftest import BASE, auth_headers


def _app(**kw):
    body = {"company": "测试公司", "jobTitle": "数据运营实习", "platform": "实习僧", "status": "已投递"}
    body.update(kw)
    r = requests.post(f"{BASE}/api/applications", json=body, timeout=10)
    assert r.status_code == 200, r.text
    return r.json()


def _collect(items, who="owner", **kw):
    return requests.post(
        f"{BASE}/api/applications/collect",
        json={"items": items, **kw},
        headers=auth_headers(who),
        timeout=10,
    )


def _funnel(**params):
    return requests.get(f"{BASE}/api/funnel", params=params, timeout=10).json()


def _no_auth():
    """
    显式「没带 token」—— conftest 默认给所有请求注入 owner 的 token，
    不覆盖的话这两条鉴权用例测的其实是「已登录能不能调」，毫无意义。
    """
    return {"Authorization": ""}


# ---------- 建记录时的初始阶段 ----------

def test_create_initializes_stage_from_status():
    """新建「已投递」记录应当立刻拿到 stage=submitted，否则新投的进不了漏斗"""
    a = _app()
    assert a["stage"] == "submitted"
    assert len(a["stageHistory"]) == 1
    assert a["stageHistory"][0]["source"] == "create"


def test_create_draft_has_no_stage():
    """「待投递」是草稿，不该有 stage —— 否则分母里混进没投出去的"""
    a = _app(status="待投递")
    assert a["stage"] is None
    assert _funnel()["overall"]["total"] == 0


# ---------- 采集：只前进 ----------

def test_collect_advances_and_records_history():
    _app()
    r = _collect([{"platform": "实习僧", "company": "测试公司", "jobTitle": "数据运营实习", "stageRaw": "初筛"}])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["matched"] == 1
    assert body["advancedCount"] == 1

    got = requests.get(f"{BASE}/api/applications", timeout=10).json()[0]
    assert got["stage"] == "screening"
    assert [h["stage"] for h in got["stageHistory"]] == ["submitted", "screening"]


def test_collect_never_goes_backwards():
    """先到面试，再读到「被查看」（页面旧渲染）→ 必须忽略，不能把漏斗拉回去"""
    _app()
    _collect([{"platform": "实习僧", "company": "测试公司", "jobTitle": "数据运营实习", "stageRaw": "面试"}])
    r = _collect([{"platform": "实习僧", "company": "测试公司", "jobTitle": "数据运营实习", "stageRaw": "被查看"}])
    assert r.json()["advancedCount"] == 0

    got = requests.get(f"{BASE}/api/applications", timeout=10).json()[0]
    assert got["stage"] == "interview"


def test_rejected_overrides_interview_but_not_offer():
    """不合格能盖掉面试（面试后被拒是常态），但盖不掉已录用（那是脏数据）"""
    _app()
    item = {"platform": "实习僧", "company": "测试公司", "jobTitle": "数据运营实习"}
    _collect([{**item, "stageRaw": "面试"}])
    _collect([{**item, "stageRaw": "不合格"}])
    assert requests.get(f"{BASE}/api/applications", timeout=10).json()[0]["stage"] == "rejected"

    _app(company="已录用公司", jobTitle="AI 产品实习")
    offer = {"platform": "实习僧", "company": "已录用公司", "jobTitle": "AI 产品实习"}
    _collect([{**offer, "stageRaw": "录用"}])
    r = _collect([{**offer, "stageRaw": "不合格"}])
    assert r.json()["advancedCount"] == 0
    got = [x for x in requests.get(f"{BASE}/api/applications", timeout=10).json() if x["company"] == "已录用公司"][0]
    assert got["stage"] == "offer"


# ---------- 采集：时间戳与匹配 ----------

def test_read_at_not_refreshed_on_repeat_sync():
    """
    同一份投递同步三次，readAt 必须停在第一次。
    否则「平均多久被查看」永远等于最后一次同步时间，指标彻底废掉。
    """
    _app(appliedAt="2026-11-01T00:00:00.000Z", platform="Boss直聘")
    item = {"platform": "Boss直聘", "company": "测试公司", "jobTitle": "数据运营实习", "read": True}
    _collect([item])
    first = requests.get(f"{BASE}/api/applications", timeout=10).json()[0]["readAt"]
    assert first

    _collect([item])
    _collect([item])
    again = requests.get(f"{BASE}/api/applications", timeout=10).json()[0]["readAt"]
    assert again == first, "重复同步把首次已读时间刷新了"


def test_unknown_record_ignored_by_default():
    """
    本地没有这家的记录 → 默认不新建。
    账本没记上就去平台页补一条，会把「我投过的」和「平台上有的」混成一锅。
    """
    r = _collect([{"platform": "实习僧", "company": "陌生公司", "jobTitle": "陌生岗位", "stageRaw": "初筛"}])
    assert r.json()["ignored"] == 1
    assert r.json()["created"] == 0
    assert requests.get(f"{BASE}/api/applications", timeout=10).json() == []


def test_create_missing_imports_when_explicitly_allowed():
    """显式 createMissing 才导入历史投递"""
    r = _collect(
        [{"platform": "实习僧", "company": "陌生公司", "jobTitle": "陌生岗位", "stageRaw": "笔试"}],
        createMissing=True,
    )
    body = r.json()
    assert body["created"] == 1

    got = requests.get(f"{BASE}/api/applications", timeout=10).json()[0]
    assert got["stage"] == "written"
    assert got["status"] == "已投递"


def test_same_company_different_jobs_not_confused():
    """同公司两个岗位同时投很常见，只按公司名匹配会张冠李戴"""
    _app(jobTitle="数据运营实习")
    _app(jobTitle="内容策划实习")

    _collect([{"platform": "实习僧", "company": "测试公司", "jobTitle": "内容策划实习", "stageRaw": "面试"}])

    rows = {a["jobTitle"]: a["stage"] for a in requests.get(f"{BASE}/api/applications", timeout=10).json()}
    assert rows["内容策划实习"] == "interview"
    assert rows["数据运营实习"] == "submitted", "同公司的另一个岗位被误推进了"


def test_jobid_wins_over_name_variants():
    """
    平台改文案（「数据运营实习（急招）」）时名字匹配会失效，
    jobId 才是稳定的同一性判断。
    """
    _app(jobId="job_123", jobTitle="数据运营实习")
    r = _collect(
        [
            {
                "platform": "实习僧",
                "jobId": "job_123",
                "company": "测试公司",
                "jobTitle": "数据运营实习（急招）",
                "stageRaw": "初筛",
            }
        ]
    )
    assert r.json()["matched"] == 1
    got = requests.get(f"{BASE}/api/applications", timeout=10).json()[0]
    assert got["stage"] == "screening"


# ---------- 采集：两边写法不一致也要能对上 ----------
# 2026-11-02 真机同步时全部 ignored，就是因为下面这两种写法差异。
# 这类错不报错、不抛异常，只是「一个都没推进」，最难发现。

def test_collect_matches_title_with_platform_suffix():
    """
    实习僧列表页标题带「实习招聘」尾巴（「台架测试实习生实习招聘」），
    详情页 / 本地记录是干净的「台架测试实习生」。
    不剥尾巴 → 同一条投递永远匹配不上。
    """
    _app(company="法雷奥", jobTitle="台架测试实习生")
    r = _collect(
        [{"platform": "实习僧", "company": "法雷奥", "jobTitle": "台架测试实习生实习招聘", "stageRaw": "初筛"}]
    )
    body = r.json()
    assert body["matched"] == 1, f"带「实习招聘」尾巴的标题没匹配上：{body}"
    assert body["advancedCount"] == 1


def test_collect_matches_company_with_city_suffix():
    """平台写「法雷奥-深圳」，本地存的是「法雷奥」—— 城市后缀不能挡住匹配"""
    _app(company="法雷奥", jobTitle="系统测试实习生")
    r = _collect(
        [{"platform": "实习僧", "company": "法雷奥-深圳", "jobTitle": "系统测试实习生", "stageRaw": "面试"}]
    )
    assert r.json()["matched"] == 1
    got = requests.get(f"{BASE}/api/applications", timeout=10).json()[0]
    assert got["stage"] == "interview"


def test_collect_does_not_match_across_companies():
    """
    宽松匹配必须有边界：不同公司、同名岗位不能串。
    （放宽了公司名比较之后，这条是防止匹配变「太松」的守门用例）
    """
    _app(company="甲公司", jobTitle="测试实习生")
    r = _collect([{"platform": "实习僧", "company": "乙公司", "jobTitle": "测试实习生", "stageRaw": "初筛"}])
    assert r.json()["matched"] == 0
    assert r.json()["ignored"] == 1
    got = requests.get(f"{BASE}/api/applications", timeout=10).json()[0]
    assert got["stage"] == "submitted", "别家的同名岗位被误推进了"


def test_collect_understands_success_wording():
    """实习僧列表里行内状态写的是「投递成功」，不是「已投递」—— 认不出就只能丢掉这条"""
    _app(company="蓝网科技", jobTitle="测试实习生")
    r = _collect(
        [{"platform": "实习僧", "company": "蓝网科技-深圳", "jobTitle": "测试实习生", "stageRaw": "投递成功"}]
    )
    assert r.json()["matched"] == 1
    assert r.json()["advancedCount"] == 0, "投递成功 = 仍是已投递，不该算推进"


# ---------- 漏斗口径 ----------

def test_funnel_counts_reached_from_history_not_current():
    """
    这条是漏斗最容易做错的地方：
    记录现在是不合格，但它曾经到过面试 —— 面试层必须算上它。
    只按当前 stage 统计的话，面试层会凭空少人，转化率看起来全线崩。
    """
    _app()
    item = {"platform": "实习僧", "company": "测试公司", "jobTitle": "数据运营实习"}
    _collect([{**item, "stageRaw": "面试"}])
    _collect([{**item, "stageRaw": "不合格"}])

    ov = _funnel()["overall"]
    assert ov["current"]["rejected"] == 1
    assert ov["current"]["interview"] == 0
    assert ov["reached"]["interview"] == 1, "到达面试的人数被当前状态吃掉了"
    assert ov["reached"]["submitted"] == 1
    assert ov["rateInterview"] == 100.0


def test_funnel_excludes_drafts():
    """草稿不进分母"""
    _app(status="待投递")
    _app()
    assert _funnel()["overall"]["total"] == 1


def test_funnel_group_by_direction():
    """按方向拆开才看得出「是简历问题还是方向问题」"""
    _app(direction="数据/AI")
    _app(company="另一家", direction="运营")
    _app(company="第三家", direction="运营")

    data = _funnel(groupBy="direction")
    assert data["groupBy"] == "direction"
    m = {g["key"]: g["total"] for g in data["groups"]}
    assert m["运营"] == 2
    assert m["数据/AI"] == 1
    assert data["groups"][0]["key"] == "运营", "分组应按投递量降序"


def test_funnel_without_stage_shows_zero():
    """空库不该报错，也不该 NaN"""
    ov = _funnel()["overall"]
    assert ov["total"] == 0
    assert ov["rateView"] is None


# ---------- 隔离与鉴权 ----------

def test_other_user_cannot_advance_my_record():
    """B 调 collect 不能碰到 A 的记录（不是 403，是「根本匹配不到」）"""
    _app()
    r = _collect(
        [{"platform": "实习僧", "company": "测试公司", "jobTitle": "数据运营实习", "stageRaw": "面试"}],
        who="intruder",
    )
    assert r.status_code == 200
    assert r.json()["ignored"] == 1
    assert r.json()["advancedCount"] == 0

    got = requests.get(f"{BASE}/api/applications", timeout=10).json()[0]
    assert got["stage"] == "submitted", "别人的采集把我的记录推进了"


def test_collect_rejects_empty_items():
    assert _collect([]).status_code == 400


def test_collect_requires_auth():
    r = requests.post(
        f"{BASE}/api/applications/collect", json={"items": []}, headers=_no_auth(), timeout=10
    )
    assert r.status_code == 401


def test_funnel_requires_auth():
    r = requests.get(f"{BASE}/api/funnel", headers=_no_auth(), timeout=10)
    assert r.status_code == 401


@pytest.mark.parametrize(
    "raw,expect",
    [
        ("简历被查看", "viewed"),
        ("HR 已查看", "viewed"),
        ("不合适", "rejected"),
        ("未通过", "rejected"),
        ("初筛中", "screening"),
        ("已发笔试", "written"),
        ("约面试", "interview"),
        ("已录用", "offer"),
        ("乱七八糟的文案", None),
        ("", None),
    ],
)
def test_stage_text_parsing(raw, expect):
    """平台文案千奇百怪，解析必须认得出转化、也必须认不出噪声时不瞎猜"""
    _app()
    before = requests.get(f"{BASE}/api/applications", timeout=10).json()[0]["stage"]
    _collect([{"platform": "实习僧", "company": "测试公司", "jobTitle": "数据运营实习", "stageRaw": raw}])
    after = requests.get(f"{BASE}/api/applications", timeout=10).json()[0]["stage"]
    if expect is None:
        assert after == before, f"{raw!r} 被误判成了 {after}"
    else:
        assert after == expect, f"{raw!r} 解析成 {after}，期望 {expect}"
