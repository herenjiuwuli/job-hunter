"""接口测试：AI 按 JD 定制（/api/tailor）—— job-hunter 独有"""
import requests

BASE = "http://localhost:3100"

JD = "负责 Vue3 前端开发，需要 Node.js 经验，有测试意识者优先"


def _make_resume():
    r = requests.post(f"{BASE}/api/resumes", json={
        "title": "全栈开发",
        "target": "全栈开发",
        "basic": {"name": "晨", "school": "广州科技职业技术大学"},
        "skills": ["Vue3", "Node.js"],
        "experiences": [{"company": "MCN机构", "role": "达人运营实习", "points": ["数据回收"]}],
        "projects": [],
        "selfEvaluation": "踏实",
    }, timeout=10)
    return r.json()["id"]


def test_tailor_missing_resume():
    """缺 resumeId → 400"""
    r = requests.post(f"{BASE}/api/tailor", json={"jd": JD}, timeout=10)
    assert r.status_code == 400


def test_tailor_missing_jd():
    """缺 jd → 400"""
    rid = _make_resume()
    r = requests.post(f"{BASE}/api/tailor", json={"resumeId": rid}, timeout=10)
    assert r.status_code == 400


def test_tailor_resume_not_found():
    """简历不存在 → 404"""
    r = requests.post(f"{BASE}/api/tailor",
                      json={"resumeId": "not-exist", "jd": JD}, timeout=10)
    assert r.status_code == 404


def test_tailor_normal():
    """正路 → 200，返回四件套：greeting/coverLetter/tailoredResume/matchPoints"""
    rid = _make_resume()
    r = requests.post(f"{BASE}/api/tailor", json={
        "resumeId": rid, "jd": JD, "company": "测试公司", "jobTitle": "前端实习生",
    }, timeout=30)
    assert r.status_code == 200
    data = r.json()
    assert data["greeting"]
    assert data["coverLetter"]
    assert data["tailoredResume"]
    assert len(data["matchPoints"]) == 3
