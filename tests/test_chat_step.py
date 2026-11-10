"""
BOSS 聊天推进（chatStep）的契约测试（2026-11-10 主人定的口径）。

守的是业务事实：**BOSS 不推进平台状态**。HR 拒绝你都不改状态，只会发一句「不太合适」，
所以 90 条 BOSS 投递在库里全停在「已投递」—— 但其中一部分已经要了微信、约了面试。
进度只能从聊天内容里读，这就是 chatStep 存在的理由：

    已投递 → 已读不回 → 有进一步交流 → 交换微信 / 要简历 → 面试邀请 → 拿到 Offer

三条容易写错的细节，这组用例钉死：
  1. **只升不降**：聊到面试之后再说「有进一步交流」不许掉回去；
  2. 只有**聊天页来源**能写（列表页没有聊天上下文，不能拿它冲掉已有进展）；
  3. 已判「不合格」的不再往前推（人都不考虑了，还挂个「面试邀请」只会误导）。
"""
import requests
from conftest import BASE, auth_headers

JOB = {
    "company": "聊天推进测试公司",
    "jobTitle": "测试开发实习生",
    "platform": "BOSS直聘",
    "status": "已投递",
}


def _app(**kw):
    body = dict(JOB)
    body.update(kw)
    r = requests.post(f"{BASE}/api/applications", json=body, timeout=10)
    assert r.status_code == 200, r.text
    return r.json()


def _collect(items):
    return requests.post(
        f"{BASE}/api/applications/collect",
        json={"items": items},
        headers=auth_headers("owner"),
        timeout=10,
    )


def _chat(**kw):
    """聊天页采集条目：没有 jobId、没有 stage，只有聊天事实"""
    it = {
        "platform": "BOSS直聘",
        "source": "chat",
        "company": JOB["company"],
        "jobTitle": JOB["jobTitle"],
        "myMsgCount": 2,  # 我发过招呼，才算我的投递
    }
    it.update(kw)
    return it


def _row():
    lst = requests.get(f"{BASE}/api/applications", timeout=10).json()
    assert len(lst) == 1, lst
    return lst[0]


def test_contact_written_on_first_sync():
    """第一次同步就挑到「加个微信」→ 直接记成「交换微信 / 要简历」，并把原话留档"""
    _app()
    _collect([_chat(chatStep="contact", chatStepText="方便加个微信聊吗")])
    row = _row()
    assert row["chatStep"] == "contact", row.get("chatStep")
    assert row["chatStepAt"], "要能回答「什么时候到的这档」"
    assert "微信" in row["chatStepEvidence"], "依据那句话必须能核对"
    assert [h["step"] for h in row["chatStepHistory"]] == ["contact"]


def test_step_only_advances():
    """先约面试、后回到「有进一步交流」→ 不许退档（递进是单向的）"""
    _app()
    _collect([_chat(chatStep="interview", chatStepText="周三下午方便来面试吗")])
    assert _row()["chatStep"] == "interview"

    _collect([_chat(chatStep="replied", chatStepText="好的，我看看")])
    row = _row()
    assert row["chatStep"] == "interview", "聊天推进只升不降"
    assert [h["step"] for h in row["chatStepHistory"]] == ["interview"], "历史也不该多一条回退记录"


def test_read_no_reply_needs_read_icon():
    """已读不回是一档真进展，但它**必须**有「我方消息被读」这个事实"""
    _app()
    _collect([_chat(chatStep="readNoReply")])
    assert _row()["chatStep"] == "readNoReply"


def test_list_source_cannot_write_chat_step():
    """列表页同步没有聊天上下文 → 带 chatStep 也不采信（否则一次同步就把进展冲了）"""
    _app()
    _collect([_chat(chatStep="contact")])
    _collect(
        [
            {
                "platform": "BOSS直聘",
                "company": JOB["company"],
                "jobTitle": JOB["jobTitle"],
                "stageRaw": "简历被查看",
                "chatStep": "submitted",  # 一个旧版扩展 / 列表页不该有的值
            }
        ]
    )
    assert _row()["chatStep"] == "contact"


def test_rejected_blocks_further_steps():
    """已经判「不合格」的，不再往「面试邀请」推 —— 那会让看板自相矛盾"""
    _app()
    _collect([_chat(chatStep="replied", chatVerdict="rejected", chatVerdictText="不好意思，不太匹配")])
    assert _row()["stage"] == "rejected"

    _collect([_chat(chatStep="interview", chatStepText="方便来面试吗")])
    row = _row()
    assert row["chatStep"] != "interview", "拒了之后不该出现「面试邀请」"
