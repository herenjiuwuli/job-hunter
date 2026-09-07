"""接口测试：投递助手（/api/apply/assist）"""
import requests

BASE = "http://localhost:3100"
SAMPLE_RESUME = "我叫陈晨，计算机专业本科，会 Vue3、Node.js、Python，做过全栈项目，会用 pytest 写测试。"


def test_assist_missing_resume():
    """缺简历 → 400"""
    r = requests.post(f"{BASE}/api/apply/assist",
                      json={"job": "前端开发"}, timeout=10)
    assert r.status_code == 400


def test_assist_missing_job():
    """缺岗位 → 400"""
    r = requests.post(f"{BASE}/api/apply/assist",
                      json={"resume": SAMPLE_RESUME}, timeout=10)
    assert r.status_code == 400


def test_assist_custom_job():
    """任意岗位（不在知识库）→ 200，按自定义岗位生成素材"""
    r = requests.post(f"{BASE}/api/apply/assist",
                      json={"resume": SAMPLE_RESUME, "job": "新媒体运营",
                            "jd": "负责小红书内容运营"}, timeout=30)
    assert r.status_code == 200
    data = r.json()
    assert data["greeting"]
    assert data["coverLetter"]


def test_assist_normal():
    """正常 → 200，返回投递清单 + 打招呼语 + 求职信"""
    r = requests.post(f"{BASE}/api/apply/assist",
                      json={"resume": SAMPLE_RESUME, "job": "前端开发"}, timeout=30)
    assert r.status_code == 200
    data = r.json()
    assert len(data["applyList"]) > 0               # 有投递清单
    assert data["greeting"]                         # 有打招呼语
    assert data["coverLetter"]                      # 有求职信
