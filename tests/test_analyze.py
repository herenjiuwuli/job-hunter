"""接口测试：简历分析 + 岗位推荐（/api/analyze）"""
import requests

BASE = "http://localhost:3100"
SAMPLE_RESUME = "我叫陈晨，计算机专业本科，会 Vue3、Node.js、Python，做过 AI 热点选题助手全栈项目，会用 pytest 写接口测试。"


def test_analyze_empty_resume():
    """空简历 → 400"""
    r = requests.post(f"{BASE}/api/analyze", json={"resume": ""}, timeout=10)
    assert r.status_code == 400
    assert "error" in r.json()


def test_analyze_missing_resume():
    """不传简历 → 400"""
    r = requests.post(f"{BASE}/api/analyze", json={}, timeout=10)
    assert r.status_code == 400


def test_analyze_normal():
    """正常简历 → 200，返回 4 个评分维度 + 岗位推荐"""
    r = requests.post(f"{BASE}/api/analyze",
                      json={"resume": SAMPLE_RESUME, "questions": 3}, timeout=30)
    assert r.status_code == 200
    data = r.json()
    assert len(data["matchScores"]) == 4          # 固定 4 个维度
    assert len(data["recommendJobs"]) > 0          # 有岗位推荐
    # 岗位名必须来自知识库
    valid_names = {"前端开发", "自动化测试", "后端开发", "产品运营", "数据分析"}
    for job in data["recommendJobs"]:
        assert job["name"] in valid_names
        assert 0 <= job["score"] <= 100


def test_analyze_predicted_questions_count():
    """预测问题数量应等于请求的题数"""
    r = requests.post(f"{BASE}/api/analyze",
                      json={"resume": SAMPLE_RESUME, "questions": 3}, timeout=30)
    assert r.status_code == 200
    assert len(r.json()["predictedQuestions"]) == 3
