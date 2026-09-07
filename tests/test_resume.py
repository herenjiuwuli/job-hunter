"""接口测试：AI 生成简历（/api/resume/generate）"""
import requests

BASE = "http://localhost:3100"
BASIC_INFO = {
    "name": "陈晨",
    "school": "XX大学",
    "major": "计算机",
    "skills": "Vue3, Node.js, Python, pytest",
    "projects": "做过 AI 热点选题助手（热榜+选题+部署），写过接口自动化测试",
    "targetJobs": ["前端开发", "自动化测试"],
}


def test_generate_missing_name():
    """缺姓名 → 400"""
    r = requests.post(f"{BASE}/api/resume/generate",
                      json={"basicInfo": {"name": ""}}, timeout=10)
    assert r.status_code == 400


def test_generate_no_skills_no_projects():
    """技能和项目都空 → 400"""
    r = requests.post(f"{BASE}/api/resume/generate",
                      json={"basicInfo": {"name": "陈晨", "skills": "", "projects": ""}}, timeout=10)
    assert r.status_code == 400


def test_generate_normal():
    """正常生成 → 200，返回 resumeText 和多岗位版本"""
    r = requests.post(f"{BASE}/api/resume/generate",
                      json={"basicInfo": BASIC_INFO}, timeout=30)
    assert r.status_code == 200
    data = r.json()
    assert data["resumeText"]                       # 有简历正文
    assert len(data["versions"]) == 2               # 两个目标岗位 → 两个版本
