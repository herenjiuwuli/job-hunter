"""
「聊天里明确拒了」→ 推进「不合格」的契约测试。

为什么需要这条：BOSS **不会改平台状态**。HR 拒绝你，只是发一句
「不好意思，您和岗位不太匹配」，列表页 tab 一直停在「已投递」。
不读聊天内容，账本就永远显示已投递 —— 漏斗里的「不合格」那层永远是 0。

边界（这几条比正例更重要）：
  · 空串 / 没有这个字段 → 什么都不做（判不出来就不下结论）
  · 已经是 offer → 不许被一条消息推翻
  · 判成 rejected 后「待我回复」要跟着灭（拒信不是问话）
"""
import requests
from conftest import BASE, auth_headers


def _app(**kw):
    body = {"company": "聊天判定公司", "jobTitle": "自动化测试实习", "platform": "BOSS直聘", "status": "已投递"}
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


def _mine(company):
    rows = requests.get(f"{BASE}/api/applications", timeout=10).json()
    return [x for x in rows if x["company"] == company][0]


def test_chat_verdict_advances_to_rejected():
    """平台状态没变，但对方在聊天里说「已招满」→ 必须进不合格"""
    _app()
    r = _collect(
        [
            {
                "platform": "BOSS直聘",
                "company": "聊天判定公司",
                "jobTitle": "自动化测试实习",
                "source": "chat",
                "lastFrom": "other",
                "myMsgCount": 1,
                "chatVerdict": "rejected",
                "chatVerdictText": "抱歉，该岗位已招满，感谢您的关注",
            }
        ]
    )
    assert r.status_code == 200, r.text
    assert r.json()["advancedCount"] == 1

    got = _mine("聊天判定公司")
    assert got["stage"] == "rejected"
    # source 必须区分开：这是从聊天内容判的，不是平台状态
    last = got["stageHistory"][-1]
    assert last["stage"] == "rejected"
    assert last["source"] == "chat"
    assert "已招满" in last["raw"]


def test_no_verdict_keeps_stage():
    """判不出来时不许动 —— 空串是常态（绝大多数会话都在谈流程）"""
    _app(company="无结论公司", jobTitle="测试开发实习")
    before = _mine("无结论公司")["stage"]
    r = _collect(
        [
            {
                "platform": "BOSS直聘",
                "company": "无结论公司",
                "jobTitle": "测试开发实习",
                "source": "chat",
                "lastFrom": "other",
                "myMsgCount": 1,
                "chatVerdict": "",
                "chatVerdictText": "",
            }
        ]
    )
    assert r.json()["advancedCount"] == 0
    assert _mine("无结论公司")["stage"] == before


def test_verdict_does_not_downgrade_offer():
    """已录用不能被一条「不合适」推翻（只升不降，rejected 权重 8 < offer 9）"""
    _app(company="已录用公司", jobTitle="AI 测试实习", status="已投递")
    _collect(
        [
            {
                "platform": "BOSS直聘",
                "company": "已录用公司",
                "jobTitle": "AI 测试实习",
                "stageRaw": "录用",
            }
        ]
    )
    assert _mine("已录用公司")["stage"] == "offer"

    r = _collect(
        [
            {
                "platform": "BOSS直聘",
                "company": "已录用公司",
                "jobTitle": "AI 测试实习",
                "source": "chat",
                "lastFrom": "other",
                "myMsgCount": 1,
                "chatVerdict": "rejected",
                "chatVerdictText": "不好意思，我们这边不合适",
            }
        ]
    )
    assert r.json()["advancedCount"] == 0
    assert _mine("已录用公司")["stage"] == "offer"


def test_rejected_clears_awaiting_reply():
    """拒信不是问话 —— 判成不合格后不能再挂在「待我回复」里"""
    _app(company="待回复公司", jobTitle="游戏测试实习")
    _collect(
        [
            {
                "platform": "BOSS直聘",
                "company": "待回复公司",
                "jobTitle": "游戏测试实习",
                "source": "chat",
                "lastFrom": "other",
                "myMsgCount": 1,
                "stageRaw": "被查看",
            }
        ]
    )
    assert _mine("待回复公司")["awaitingReply"] is True

    _collect(
        [
            {
                "platform": "BOSS直聘",
                "company": "待回复公司",
                "jobTitle": "游戏测试实习",
                "source": "chat",
                "lastFrom": "other",
                "myMsgCount": 1,
                "chatVerdict": "rejected",
                "chatVerdictText": "抱歉，您与该岗位不匹配",
            }
        ]
    )
    got = _mine("待回复公司")
    assert got["stage"] == "rejected"
    assert got["awaitingReply"] is False
