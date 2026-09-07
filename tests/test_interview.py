"""接口测试：模拟面试（/api/interview/start、/api/interview/answer、/api/interview/report）"""
import requests

BASE = "http://localhost:3100"
SAMPLE_RESUME = "我叫陈晨，计算机专业本科，会 Vue3、Node.js，做过全栈项目。"
HISTORY = [
    {"role": "assistant", "content": "请先做个自我介绍"},
    {"role": "user", "content": "我叫陈晨，做过 AI 热点选题助手项目，会用 Vue3 和 Node.js。"},
]


def test_start_missing_resume():
    """开始面试缺简历 → 400"""
    r = requests.post(f"{BASE}/api/interview/start", json={"job": "前端开发"}, timeout=10)
    assert r.status_code == 400


def test_start_missing_job():
    """开始面试缺岗位 → 400"""
    r = requests.post(f"{BASE}/api/interview/start", json={"resume": SAMPLE_RESUME}, timeout=10)
    assert r.status_code == 400


def test_start_custom_job():
    """任意岗位（不在知识库）→ 200，按自定义岗位出题"""
    r = requests.post(f"{BASE}/api/interview/start",
                      json={"resume": SAMPLE_RESUME, "job": "UI 设计师",
                            "jd": "负责产品界面设计", "questions": 4}, timeout=30)
    assert r.status_code == 200
    data = r.json()
    assert data["firstQuestion"]
    assert data["total"] == 4
    assert data["job"] == "UI 设计师"


def test_start_normal():
    """正常开始 → 200，返回 firstQuestion 和 total"""
    r = requests.post(f"{BASE}/api/interview/start",
                      json={"resume": SAMPLE_RESUME, "job": "前端开发", "questions": 5}, timeout=30)
    assert r.status_code == 200
    data = r.json()
    assert data["firstQuestion"]                    # 有第一题
    assert data["total"] == 5                       # 题数正确


def test_answer_empty_answer():
    """回答为空 → 400"""
    r = requests.post(f"{BASE}/api/interview/answer",
                      json={"history": HISTORY, "answer": "", "resume": SAMPLE_RESUME, "job": "前端开发"}, timeout=10)
    assert r.status_code == 400


def test_answer_empty_history():
    """历史为空 → 400"""
    r = requests.post(f"{BASE}/api/interview/answer",
                      json={"history": [], "answer": "我的回答", "resume": SAMPLE_RESUME}, timeout=10)
    assert r.status_code == 400


def test_answer_normal():
    """正常回答 → 200，返回 comment 和 nextQuestion"""
    r = requests.post(f"{BASE}/api/interview/answer",
                      json={"history": HISTORY, "answer": "我负责前端开发和接口联调。",
                            "resume": SAMPLE_RESUME, "job": "前端开发", "total": 5}, timeout=30)
    assert r.status_code == 200
    data = r.json()
    assert data["comment"]                          # 有点评
    assert data["nextQuestion"]                     # 有下一题


def test_report_missing_history():
    """报告缺历史 → 400"""
    r = requests.post(f"{BASE}/api/interview/report", json={"history": []}, timeout=10)
    assert r.status_code == 400


def test_report_normal():
    """正常生成报告 → 200，包含总分和维度"""
    r = requests.post(f"{BASE}/api/interview/report",
                      json={"history": HISTORY, "job": "前端开发"}, timeout=30)
    assert r.status_code == 200
    data = r.json()
    assert 0 <= data["totalScore"] <= 100
    assert len(data["dimensions"]) == 4             # 固定 4 个维度
    assert len(data["suggestions"]) > 0             # 有改进建议


# ===== 阶段 8 新功能测试 =====

def test_answer_returns_score():
    """正常回答 → 返回带即时评分 score（0-100）"""
    r = requests.post(f"{BASE}/api/interview/answer",
                      json={"history": HISTORY, "answer": "我负责前端开发和接口联调。",
                            "resume": SAMPLE_RESUME, "job": "前端开发", "total": 5}, timeout=30)
    assert r.status_code == 200
    data = r.json()
    assert "score" in data                          # 有评分字段
    assert 0 <= data["score"] <= 100                # 范围正确


def test_answer_returns_reference_points():
    """正常回答 → 返回参考要点 referencePoints"""
    r = requests.post(f"{BASE}/api/interview/answer",
                      json={"history": HISTORY, "answer": "我负责前端开发和接口联调。",
                            "resume": SAMPLE_RESUME, "job": "前端开发", "total": 5}, timeout=30)
    assert r.status_code == 200
    data = r.json()
    assert "referencePoints" in data                # 有参考要点字段
    assert len(data["referencePoints"]) > 0         # 非空


def test_start_with_difficulty():
    """带难度参数启动 → 200，返回第一题"""
    r = requests.post(f"{BASE}/api/interview/start",
                      json={"resume": SAMPLE_RESUME, "job": "前端开发",
                            "questions": 5, "difficulty": "hard"}, timeout=30)
    assert r.status_code == 200
    assert r.json()["firstQuestion"]


def test_answer_followup():
    """mock 返回追问标记 → 后端透传 isFollowUp=true 和追问问题"""
    follow_history = [
        {"role": "assistant", "content": "请讲讲你的项目"},
        {"role": "user", "content": "我做了 AI 选题助手项目（FOLLOWUP 标记用于触发 mock 追问）"},
    ]
    r = requests.post(f"{BASE}/api/interview/answer",
                      json={"history": follow_history, "answer": "项目遇到性能问题，我做了优化。",
                            "resume": SAMPLE_RESUME, "job": "前端开发", "total": 5}, timeout=30)
    assert r.status_code == 200
    data = r.json()
    assert data["isFollowUp"] is True               # 追问标记透传
    assert data["nextQuestion"]                     # 有追问内容
