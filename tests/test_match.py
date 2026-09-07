"""接口测试：JD vs 简历匹配打分排序（/api/match）—— job-hunter 独有"""
import requests

BASE = "http://localhost:3100"


def _make_resume(skills):
    r = requests.post(f"{BASE}/api/resumes", json={
        "title": "",
        "target": "",
        "basic": {"name": "晨"},
        "skills": skills,
        "experiences": [],
        "projects": [],
        "selfEvaluation": "",
    }, timeout=10)
    return r.json()["id"]


def _make_app(company, jd):
    requests.post(f"{BASE}/api/applications", json={
        "company": company, "jobTitle": "岗位", "jd": jd, "status": "待投递",
    }, timeout=10)


def test_match_missing_resume():
    """缺 resumeId → 400"""
    r = requests.get(f"{BASE}/api/match", timeout=10)
    assert r.status_code == 400


def test_match_resume_not_found():
    """简历不存在 → 404"""
    r = requests.get(f"{BASE}/api/match?resumeId=not-exist", timeout=10)
    assert r.status_code == 404


def test_match_sorts_by_score():
    """命中技能的 JD 分数（100%）应高于无关 JD（0%）"""
    rid = _make_resume(["Vue3", "Node.js"])
    _make_app("命中公司", "熟练使用 Vue3")   # 命中技能 → 100%
    _make_app("无关公司", "需要 Java 后端")  # 零命中 → 0%
    r = requests.get(f"{BASE}/api/match?resumeId={rid}", timeout=10)
    assert r.status_code == 200
    scored = r.json()
    assert len(scored) == 2
    scores = {x["company"]: x["score"] for x in scored}
    assert scores["命中公司"] == 100
    assert scores["无关公司"] == 0
    assert scores["命中公司"] > scores["无关公司"]


def test_match_skill_hit_weighted_higher():
    """技能字段命中（×2）应高于仅经历文本命中（×1）"""
    # 简历 A：技能字段直接含 Vue3
    ra = requests.post(f"{BASE}/api/resumes", json={
        "title": "", "target": "", "basic": {"name": "A"},
        "skills": ["Vue3"], "experiences": [], "projects": [], "selfEvaluation": "",
    }, timeout=10).json()["id"]
    # 简历 B：技能字段空，但经历文本里提到 Vue3
    rb = requests.post(f"{BASE}/api/resumes", json={
        "title": "", "target": "", "basic": {"name": "B"},
        "skills": [], "experiences": [{"role": "开发", "points": ["用 Vue3 做前端"]}],
        "projects": [], "selfEvaluation": "",
    }, timeout=10).json()["id"]

    _make_app("技能岗", "熟练使用 Vue3")  # 同一条 JD 分别对两份简历打分
    sa = requests.get(f"{BASE}/api/match?resumeId={ra}", timeout=10).json()
    sb = requests.get(f"{BASE}/api/match?resumeId={rb}", timeout=10).json()

    assert sa[0]["score"] == 100   # A：技能命中 ×2
    assert sb[0]["score"] == 50    # B：仅经历命中 ×1
    assert sa[0]["score"] > sb[0]["score"]


def test_match_no_jd_records():
    """无 JD 的投递记录被过滤"""
    rid = _make_resume(["Vue3"])
    requests.post(f"{BASE}/api/applications", json={
        "company": "无JD公司", "jobTitle": "岗位", "jd": "", "status": "待投递",
    }, timeout=10)
    r = requests.get(f"{BASE}/api/match?resumeId={rid}", timeout=10)
    assert r.status_code == 200
    assert r.json() == []
