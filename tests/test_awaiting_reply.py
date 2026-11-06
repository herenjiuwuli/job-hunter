"""
「待我回复」判据的契约测试（2026-11-06 主人纠正后新增）。

守的是一条业务事实，不是「接口能返回 200」：

    被查看 / 进初筛 只是平台把状态往前挪了一格，**不产生任何聊天消息**，
    没有任何东西等着我回。只有聊天框里「对方是最后说话的一方」才是真待办。

旧实现写成 `stage ∈ {viewed,screening,written,interview} && !repliedAt`，
于是所有被查看的岗位全变成待办，界面上天天挂着十几条假任务（主人原话：
「被查看并不代表需要我回复」）。这组用例把新判据钉死，也守住三条容易回退的细节：

  1. 老版本扩展没有 awaitingReply 字段 → 从 lastFrom / replied 推，不能直接丢
  2. 我回完之后必须能从 true 变回 false（唯一允许回落的状态位）
  3. 列表页同步没有聊天上下文 → 不能把已有的 true 冲成 false
"""
import requests
from conftest import BASE, auth_headers

JOB = {
    "company": "待回复测试公司",
    "jobTitle": "内容运营实习生",
    "platform": "BOSS直聘",
    "status": "已投递",
}


def _app(**kw):
    body = dict(JOB)
    body.update(kw)
    r = requests.post(f"{BASE}/api/applications", json=body, timeout=10)
    assert r.status_code == 200, r.text
    return r.json()


def _collect(items, who="owner"):
    return requests.post(
        f"{BASE}/api/applications/collect",
        json={"items": items},
        headers=auth_headers(who),
        timeout=10,
    )


def _chat(**kw):
    """聊天页采集条目：没有 jobId、没有 stage，只有聊天事实"""
    it = {
        "platform": "BOSS直聘",
        "source": "chat",
        "company": JOB["company"],
        "jobTitle": JOB["jobTitle"],
        # 我确实发过招呼（否则后端按「HR 主动找我」忽略这条）
        "myMsgCount": 2,
    }
    it.update(kw)
    return it


def _row():
    lst = requests.get(f"{BASE}/api/applications", timeout=10).json()
    assert len(lst) == 1, lst
    return lst[0]


def _need_action():
    r = requests.get(f"{BASE}/api/dashboard", timeout=10)
    assert r.status_code == 200, r.text
    return r.json()["applications"]["needActionCount"]


# ---------- 被查看 / 初筛不是待办 ----------

def test_viewed_is_not_a_todo():
    """状态推到「被查看」但没有聊天消息 → 不进待办"""
    _app()
    _collect(
        [
            {
                "platform": "BOSS直聘",
                "company": JOB["company"],
                "jobTitle": JOB["jobTitle"],
                "stageRaw": "简历被查看",
            }
        ]
    )
    row = _row()
    assert row["stage"] == "viewed", "阶段本身还是要推进的"
    assert not row.get("awaitingReply"), "被查看不是待回复"
    assert _need_action() == 0


def test_screening_is_not_a_todo():
    """BOSS 上状态写「初筛」但聊天框空的，属于常态 —— 同样不该提示"""
    _app()
    _collect(
        [
            {
                "platform": "BOSS直聘",
                "company": JOB["company"],
                "jobTitle": JOB["jobTitle"],
                "stageRaw": "初筛",
            }
        ]
    )
    assert _row()["stage"] == "screening"
    assert _need_action() == 0


# ---------- 聊天框里对方说话才叫待办 ----------

def test_incoming_message_marks_awaiting():
    _app()
    _collect([_chat(lastFrom="other")])
    row = _row()
    assert row["awaitingReply"] is True
    assert row["awaitingReplyAt"], "要能算「这条压了多久」"
    assert _need_action() == 1


def test_old_extension_without_awaiting_field():
    """老版本扩展只报 replied / lastFrom，也得认出来（不能等用户升级扩展才生效）"""
    _app()
    _collect([_chat(replied=True)])
    assert _row()["awaitingReply"] is True


def test_my_reply_clears_awaiting():
    """我回完 → 对方不再是最后发言 → 必须回落，否则永远挂在待办里"""
    _app()
    _collect([_chat(lastFrom="other")])
    assert _need_action() == 1
    _collect([_chat(lastFrom="me")])
    row = _row()
    assert row["awaitingReply"] is False
    assert _need_action() == 0


def test_list_page_sync_keeps_awaiting():
    """列表页采集没有聊天框 → 不传 awaitingReply → 不能把已有 true 冲掉"""
    _app()
    _collect([_chat(lastFrom="other")])
    _collect(
        [
            {
                "platform": "BOSS直聘",
                "company": JOB["company"],
                "jobTitle": JOB["jobTitle"],
                "stageRaw": "简历被查看",
            }
        ]
    )
    assert _row()["awaitingReply"] is True


def test_rejected_is_not_a_todo():
    """拒信也是「对方发的消息」，但它不需要我回"""
    _app()
    _collect([_chat(lastFrom="other", stageRaw="不合格")])
    row = _row()
    assert row["stage"] == "rejected"
    assert row["awaitingReply"] is False
    assert _need_action() == 0
