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


# ---------- 会话采集（BOSS 聊天页）：没有 jobId 时的匹配 ----------
#
# 聊天页拿不到 jobId，后端只能「公司 + 岗位名」匹配。而账本里那批一键投递的记录
# 公司名是抓页面抓错的（2026-11-05 A69277 事故：投的是正浩创新，账本记成 RAK瑞科慧联），
# 公司这一半对不上 → 已读/被拒的时间一条也传不进去 → 界面看起来「全都还是已投递」。

def _chat(company, jobTitle, **kw):
    """一条会话采集行：source=chat 且没有 jobId，这是它的真实形状"""
    return {"platform": "BOSS直聘", "company": company, "jobTitle": jobTitle, "source": "chat", **kw}


def test_collect_chat_matches_by_title_and_fixes_company():
    """
    账本公司名存错了，但岗位名在全库唯一 → 认它，并把公司名订正过来。
    不认的话，这条会话的已读/被拒永远进不了面板。
    """
    a = _app(company="RAK瑞科慧联", jobTitle="【日常实习】数据运营实习生(A69277)", platform="BOSS直聘")
    r = _collect([_chat("正浩创新", "【日常实习】数据运营实习生(A69277)", read=True)])
    body = r.json()
    assert body["matched"] == 1, f"公司名错但岗位名唯一，应当认这条：{body}"
    got = [x for x in requests.get(f"{BASE}/api/applications", timeout=10).json() if x["id"] == a["id"]][0]
    assert got["company"] == "正浩创新", "订正公司名没生效"
    assert got.get("readAt"), "已读时间没记上"


def test_collect_chat_does_not_guess_when_title_is_ambiguous():
    """
    两条同名岗位（「测试实习生」在 BOSS 上满地都是）时**不许猜** ——
    猜就是把 A 的进度写到 B 头上，比不匹配更糟。
    """
    _app(company="甲公司", jobTitle="测试实习生", platform="BOSS直聘")
    _app(company="乙公司", jobTitle="测试实习生", platform="BOSS直聘")
    r = _collect([_chat("丙公司", "测试实习生", read=True)])
    body = r.json()
    assert body["matched"] == 0
    assert body["ignored"] == 1


def test_collect_chat_skips_inbound_when_creating():
    """
    HR 主动找上门、我一句话没发过的会话不是我的投递。
    开 createMissing 时也不能拿它建记录，否则「投递量」被撑大。
    """
    r = _collect(
        [_chat("珍岛集团", "27届校招-TOB软件销售", myMsgCount=0, firstFrom="other")],
        createMissing=True,
    )
    body = r.json()
    assert body["created"] == 0
    assert body["ignored"] == 1
    assert "HR 主动" in (body["results"][0].get("reason") or "")



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


def test_collect_keeps_direction_from_extension():
    """
    扩展在**投递那一刻**按标题判好了方向，采集/补传必须把它带进来。

    不带的话，存量记录只能靠 data/jd/jobs.json 兜底 —— 那份语料只有 5 条且 direction 全空，
    等于 36 条里 34 条没方向，`?groupBy=direction` 只剩「未分类」，漏斗最有价值那句话算不出来
    （2026-11-05 实测）。
    """
    r = _collect(
        [
            {
                "platform": "BOSS直聘",
                "company": "方向甲",
                "jobTitle": "数据运营实习",
                "stageRaw": "已投递",
                "direction": "数据分析 / 数据运营",
            }
        ],
        createMissing=True,
    )
    assert r.json()["created"] == 1, r.text
    got = [a for a in requests.get(f"{BASE}/api/applications", timeout=10).json() if a["company"] == "方向甲"]
    assert got and got[0]["direction"] == "数据分析 / 数据运营"


def test_collect_does_not_overwrite_direction():
    """已有方向不覆盖：人工改过的值不许被一次采集刷回去（采集只知道标题，不知道你的判断）"""
    _app(company="方向乙", direction="人工标注")
    _collect(
        [
            {
                "platform": "实习僧",
                "company": "方向乙",
                "jobTitle": "数据运营实习",
                "stageRaw": "已投递",
                "direction": "数据分析 / 数据运营",
            }
        ]
    )
    got = [x for x in requests.get(f"{BASE}/api/applications", timeout=10).json() if x["company"] == "方向乙"]
    assert got and got[0]["direction"] == "人工标注"


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


# ---------- collect 的逐条处置明细（扩展端靠它决定记不记「已同步」） ----------
# 为什要单独守：扩展端把「jobId + 阶段」缓存起来，上次报过的下次跳过。
# 只看 HTTP 200 就记账，会把 ignored 的也记成已同步 —— 那条以后永远不再上报，
# 页面上有、库里永远没有，而且看起来一切正常（2026-11-03 丢过一条「初筛」）。


def _result_of(data, job_title):
    for r in data.get("results") or []:
        if r.get("jobTitle") == job_title:
            return r
    return None


def test_collect_reports_advanced_detail():
    """阶段推进 → 明细里能看出 from/to，扩展端据此记账"""
    _app(company="明细甲", jobTitle="推进岗")
    r = _collect([{"platform": "实习僧", "company": "明细甲", "jobTitle": "推进岗", "stageRaw": "初筛"}])
    assert r.status_code == 200, r.text
    data = r.json()
    item = _result_of(data, "推进岗")
    assert item is not None, data
    assert item["action"] == "advanced"
    assert item["from"] == "submitted"
    assert item["to"] == "screening"


def test_collect_reports_unchanged_detail():
    """阶段没变 → unchanged，仍算「后端收下了」，可以记账"""
    _app(company="明细乙", jobTitle="不动岗")
    _collect([{"platform": "实习僧", "company": "明细乙", "jobTitle": "不动岗", "stageRaw": "初筛"}])
    r = _collect([{"platform": "实习僧", "company": "明细乙", "jobTitle": "不动岗", "stageRaw": "初筛"}])
    item = _result_of(r.json(), "不动岗")
    assert item["action"] == "unchanged"


def test_collect_reports_ignored_with_reason():
    """对不上账本 → ignored + 原因。扩展端必须据此**不记账**，否则永久跳过"""
    r = _collect([{"platform": "实习僧", "company": "根本没有这家", "jobTitle": "也没有这个岗", "stageRaw": "初筛"}])
    data = r.json()
    assert data["ignored"] == 1
    item = _result_of(data, "也没有这个岗")
    assert item is not None, data
    assert item["action"] == "ignored"
    assert item.get("reason"), "ignored 必须带原因，否则前端没法给用户看"
    # 没开 createMissing 时绝不能入库
    assert not any(a["company"] == "根本没有这家" for a in requests.get(f"{BASE}/api/applications", timeout=10).json())


def test_collect_reports_created_detail():
    """开了 createMissing → created，同样可以记账"""
    r = _collect(
        [{"platform": "实习僧", "company": "新建丙", "jobTitle": "新建岗", "stageRaw": "笔试"}],
        createMissing=True,
    )
    data = r.json()
    assert data["created"] == 1
    item = _result_of(data, "新建岗")
    assert item["action"] == "created"
    assert item["stage"] == "written"


def test_collect_self_heals_tag_as_title():
    """
    标题被「届别标签」占过时，jobId 精确命中要能自愈。

    真机事故（2026-11-03，华曦达 3 条）：实习僧岗位名元素里是「27届\n测试实习生」，
    采集端取第一行 → 三条不同岗位的标题全成了「27届」。
    采集端已修，但**写坏的旧值不会自己好** —— 不覆盖就是永久错，
    而且这三条会一直占着「方向判不出来」的位置。
    """
    a = _app(company="SDMC华曦达科技", jobTitle="27届", platform="实习僧", jobId="inn_tag_title_1")
    r = _collect(
        [
            {
                "company": "SDMC华曦达科技",
                "jobTitle": "测试实习生",
                "platform": "实习僧",
                "jobId": "inn_tag_title_1",
                "stage": "submitted",
            }
        ]
    )
    assert r.status_code == 200, r.text
    got = [x for x in requests.get(f"{BASE}/api/applications", timeout=10).json() if x["id"] == a["id"]][0]
    assert got["jobTitle"] == "测试实习生", "jobId 硬命中却没订正标题"
    body = r.json()
    assert any(x.get("titleFixed") for x in body["results"]), "订正了标题但没在 results 里说明"


def test_collect_does_not_overwrite_normal_title():
    """
    反过来：**正常标题不许乱改**。

    标题是 sameApply 认人的主要依据（公司 + 岗位名），平台改一次文案就覆盖一次，
    等于自己给自己制造错配。自愈只对「旧值确实是标签」生效。
    """
    a = _app(company="某公司", jobTitle="测试实习生", platform="实习僧", jobId="inn_keep_title_1")
    _collect(
        [
            {
                "company": "某公司",
                "jobTitle": "测试实习生（急招）",
                "platform": "实习僧",
                "jobId": "inn_keep_title_1",
                "stage": "submitted",
            }
        ]
    )
    got = [x for x in requests.get(f"{BASE}/api/applications", timeout=10).json() if x["id"] == a["id"]][0]
    assert got["jobTitle"] == "测试实习生", "正常标题被平台文案覆盖了（会破坏公司+岗位的认人规则）"


def test_withdrawn_does_not_touch_stage():
    """
    我主动放弃 → 只写 withdrawnAt，**stage 一格都不许动**。

    反例（真实数据 2026-10-30 惊叹科技）：我在聊天里说「不太适合我，祝您早日找到」。
    若把它当 rejected，漏斗「不合格」那层会凭空多一批 —— HR 压根没拒我，
    被拒率跟着虚高，简历上那句「被拒率 X%」就是假的。
    """
    a = _app(company="惊叹科技", jobTitle="编导创意实习生", platform="BOSS直聘")
    r = _collect(
        [
            {
                "company": "惊叹科技",
                "jobTitle": "编导创意实习生",
                "platform": "BOSS直聘",
                "stage": "viewed",
                "read": True,
                "withdrawn": True,
                "source": "chat",
                "myMsgCount": 4,
            }
        ]
    )
    assert r.status_code == 200, r.text
    got = [x for x in requests.get(f"{BASE}/api/applications", timeout=10).json() if x["id"] == a["id"]][0]
    assert got["withdrawnAt"], "没记下「我放弃」"
    assert got["stage"] == "viewed", "我放弃不该改阶段（更不该变成 rejected）"


def test_withdrawn_keeps_first_time_only():
    """反复同步不能把「我哪天放弃的」刷成今天 —— 这跟已读/回复是同一类口径。"""
    a = _app(company="某公司", jobTitle="运营实习生", platform="BOSS直聘")
    item = {
        "company": "某公司",
        "jobTitle": "运营实习生",
        "platform": "BOSS直聘",
        "withdrawn": True,
        "source": "chat",
        "myMsgCount": 2,
    }
    _collect([item])
    first = [x for x in requests.get(f"{BASE}/api/applications", timeout=10).json() if x["id"] == a["id"]][0][
        "withdrawnAt"
    ]
    assert first
    import time

    time.sleep(0.02)
    _collect([{**item, "withdrawnAt": "2026-12-31T00:00:00.000Z"}])
    again = [x for x in requests.get(f"{BASE}/api/applications", timeout=10).json() if x["id"] == a["id"]][0][
        "withdrawnAt"
    ]
    assert again == first, "「我放弃」的时间被后一次同步覆盖了"

def test_collect_chat_can_adopt_when_user_asks():
    """
    用户点「补录」时（createMissing=True），我自己发过消息的会话要能建进账本。

    这批是真实数据：炽光 / 惊叹 / 未来范式 / 知羽俊采 4 条在 BOSS 聊天页上确实存在，
    但账本从来没记过（当时投递没回写成功）。不补进来的话，投递量永远比平台少 4 家，
    漏斗分母偏小 → 所有转化率分母都错。
    """
    r = _collect(
        [_chat("炽光时代", "用户运营实习生（双休/AI赛道）", myMsgCount=3, firstFrom="me", read=True)],
        createMissing=True,
    )
    body = r.json()
    assert body["created"] == 1, f"补录没建记录：{body}"
    got = requests.get(f"{BASE}/api/applications", timeout=10).json()
    hit = [x for x in got if x["company"] == "炽光时代"]
    assert len(hit) == 1
    assert hit[0]["stage"] == "submitted", "补录进来的没有阶段（漏斗里会变成草稿被排除）"
    assert hit[0]["readAt"], "已读时间没跟着记上"


def test_collect_chat_never_adopts_inbound_even_with_create_missing():
    """补录也不许把「HR 主动找我」算成我的投递 —— 这条是 404 还是 201 都不能破的。"""
    r = _collect(
        [_chat("某某集团", "校招-销售", myMsgCount=0, firstFrom="other")],
        createMissing=True,
    )
    body = r.json()
    assert body["created"] == 0, "补录把进线会话也建了，投递量会虚高"
    assert not [x for x in requests.get(f"{BASE}/api/applications", timeout=10).json() if x["company"] == "某某集团"]


def test_collect_advances_when_only_tab_gave_the_stage():
    """
    stageRaw 为空、只有 stage key 时必须照样推进。

    真实形态：实习僧「初筛」tab 里那一行的文案**还是旧的**（「投递成功」），
    阶段只能由分类 tab 判定 → 采集端发 `stageRaw: ''` + `stage: 'screening'`。
    后端原来写 `raw.stageRaw ?? raw.stage`：空串不是 null，?? 不兜底 →
    parseStage('') → null → **这一档永远推不上去**，而界面显示「无新变化」，看起来一切正常。
    2026-11-05 回放真账本（9 条会话）时就是这么暴露的：推进数恒为 0。
    """
    a = _app(company="TCL实业", jobTitle="HR-数据运营实习生", platform="BOSS直聘")
    r = _collect(
        [
            {
                "company": "TCL实业",
                "jobTitle": "HR-数据运营实习生",
                "platform": "BOSS直聘",
                "stageRaw": "",
                "stage": "screening",
            }
        ]
    )
    assert r.status_code == 200, r.text
    got = [x for x in requests.get(f"{BASE}/api/applications", timeout=10).json() if x["id"] == a["id"]][0]
    assert got["stage"] == "screening", "只靠 tab 判出来的阶段被丢掉了（stageRaw 空串没兜底）"


def test_collect_fills_missing_company_on_exact_jobid_hit():
    """
    库里是「未知公司」时，jobId 精确命中的采集也要把公司名填上。

    真机（2026-11-06）：中金财富那 2 条记录的 jobId 一直在库里，采集每次都能拿到
    「中金财富（深圳）」，但公司名一直是「未知公司」。
    根因是订正只在「按标题兜底命中」（viaTitle）时生效 —— 精确命中走了另一条分支，
    于是这个空位永远填不上。「未知公司」不是数据，是采集失败留下的坑。

    ⚠️ 只订正**空 / 未知**：库里已有真实公司名时不许被采集覆盖（下一条用例守）。
    """
    a = _app(company="未知公司", jobTitle="产品测试助理实习生(J15383)", platform="实习僧", jobId="inn_unknown_co_1")
    r = _collect(
        [
            {
                "company": "中金财富",
                "jobTitle": "产品测试助理实习生(J15383)",
                "platform": "实习僧",
                "jobId": "inn_unknown_co_1",
                "stage": "viewed",
            }
        ]
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["matched"] == 1
    got = [x for x in requests.get(f"{BASE}/api/applications", timeout=10).json() if x["id"] == a["id"]][0]
    assert got["company"] == "中金财富", "jobId 精确命中、库里只有「未知公司」，却没用采集到的公司名补上"
    assert any(x.get("companyFixed") for x in body["results"]), "补了公司名但没在 results 里说明（界面就看不到）"


def test_collect_does_not_overwrite_real_company():
    """
    反过来：库里已有真实公司名时，采集不许覆盖。

    采集端的公司名可能是「法雷奥-全国」这种带城市后缀、或者干脆来自别的卡片；
    真实名被覆盖 = 自己制造错配（公司名是 sameApply 认人的一半依据）。
    """
    a = _app(company="法雷奥", jobTitle="测试实习生", platform="实习僧", jobId="inn_real_co_1")
    _collect(
        [
            {
                "company": "别的公司",
                "jobTitle": "测试实习生",
                "platform": "实习僧",
                "jobId": "inn_real_co_1",
                "stage": "screening",
            }
        ]
    )
    got = [x for x in requests.get(f"{BASE}/api/applications", timeout=10).json() if x["id"] == a["id"]][0]
    assert got["company"] == "法雷奥", "采集把已有真实公司名覆盖掉了"
