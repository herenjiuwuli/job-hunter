"""接口测试：求职总览看板（/api/dashboard）—— 聚合简历/投递/面试/画像"""
import requests

BASE = "http://localhost:3100"


def test_dashboard_empty_defaults():
    """无任何数据时：结构完整，计数为 0，目标岗位为空"""
    r = requests.get(f"{BASE}/api/dashboard", timeout=10)
    assert r.status_code == 200
    body = r.json()
    assert body["counts"]["resumes"] == 0
    assert body["counts"]["applications"] == 0
    assert body["counts"]["records"] == 0
    assert body["counts"]["profileFilled"] is False
    assert body["applications"]["activeCount"] == 0
    assert body["interview"]["avgScore"] == 0
    assert body["interview"]["wrongCount"] == 0
    assert body["targets"] == []


def test_dashboard_application_distribution():
    """造多条不同状态/结果的投递 → byStatus/byResult 统计正确、终态不计入进行中"""
    for company, status, result in [
        ("A公司", "已投递", "已确认提交"),
        ("B公司", "已沟通", "待处理"),
        ("C公司", "已offer", "已确认提交"),
        ("D公司", "已拒绝", "跳过"),
        ("E公司", "已淘汰", "被拦截"),
    ]:
        requests.post(f"{BASE}/api/applications", json={
            "company": company, "jobTitle": "岗位", "status": status, "result": result,
        }, timeout=10)

    body = requests.get(f"{BASE}/api/dashboard", timeout=10).json()
    bs = body["applications"]["byStatus"]
    br = body["applications"]["byResult"]
    assert bs["已投递"] == 1
    assert bs["已沟通"] == 1
    assert bs["已offer"] == 1
    assert bs["已拒绝"] == 1
    assert bs["已淘汰"] == 1
    assert br["已确认提交"] == 2
    assert br["待处理"] == 1
    assert br["跳过"] == 1
    assert br["被拦截"] == 1
    # 进行中 = 排除「已拒绝/已淘汰」两个终态
    assert body["applications"]["activeCount"] == 3


def test_dashboard_interview_metrics():
    """造面试记录（含错题标记）→ avgScore/latestScore/wrongCount 计算正确"""
    requests.post(f"{BASE}/api/records", json={
        "job": "前端开发",
        "questions": 2,
        "report": {
            "totalScore": 80,
            "perQuestion": [
                {"q": "题1", "score": 90, "wrong": False},
                {"q": "题2", "score": 50, "wrong": True},
            ],
        },
    }, timeout=10)
    requests.post(f"{BASE}/api/records", json={
        "job": "游戏策划",
        "questions": 1,
        "report": {"totalScore": 60, "perQuestion": [{"q": "题1", "score": 60, "wrong": True}]},
    }, timeout=10)

    body = requests.get(f"{BASE}/api/dashboard", timeout=10).json()
    iv = body["interview"]
    assert body["counts"]["records"] == 2
    assert iv["avgScore"] == 70  # (80+60)/2
    assert iv["wrongCount"] == 2  # 50 + 60 两题都低于 70
    assert 60 <= iv["latestScore"] <= 80  # 最近一场（按时间倒序，两场时间几乎相同，取其一）


def test_dashboard_targets_from_profile():
    """画像里填了目标岗位 → dashboard 的 targets 透出"""
    requests.put(f"{BASE}/api/profile", json={
        "targets": {"primaryRoles": ["前端开发", "游戏策划"]},
        "basic": {"name": "晨"},
    }, timeout=10)
    body = requests.get(f"{BASE}/api/dashboard", timeout=10).json()
    assert body["targets"] == ["前端开发", "游戏策划"]
    assert body["counts"]["profileFilled"] is True
