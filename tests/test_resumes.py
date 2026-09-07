"""接口测试：简历库 CRUD（/api/resumes）—— job-hunter 独有"""
import requests

BASE = "http://localhost:3100"


def _make(title="全栈开发"):
    return {
        "title": title,
        "target": "全栈开发",
        "basic": {"name": "晨", "school": "广州科技职业技术大学"},
        "skills": ["Vue3", "Node.js"],
        "experiences": [{"company": "MCN机构", "role": "达人运营实习", "points": ["数据回收"]}],
        "projects": [],
        "selfEvaluation": "踏实",
        "content": "# 简历成品\n\n## 技能\nVue3",
    }


def test_create_and_list():
    """创建简历 → 200，content 字段落库，列表能查到"""
    r = requests.post(f"{BASE}/api/resumes", json=_make(), timeout=10)
    assert r.status_code == 200
    data = r.json()
    assert data["id"]
    assert data["title"] == "全栈开发"
    assert data["content"] == "# 简历成品\n\n## 技能\nVue3"

    r2 = requests.get(f"{BASE}/api/resumes", timeout=10)
    assert r2.status_code == 200
    assert any(x["id"] == data["id"] for x in r2.json())


def test_get_single():
    """按 id 查单条 → 200"""
    created = requests.post(f"{BASE}/api/resumes", json=_make(), timeout=10).json()
    r = requests.get(f"{BASE}/api/resumes/{created['id']}", timeout=10)
    assert r.status_code == 200
    assert r.json()["id"] == created["id"]


def test_get_not_found():
    """查不存在的简历 → 404"""
    r = requests.get(f"{BASE}/api/resumes/not-exist", timeout=10)
    assert r.status_code == 404


def test_update():
    """更新简历 → 200，字段更新且 id 不变"""
    created = requests.post(f"{BASE}/api/resumes", json=_make(), timeout=10).json()
    r = requests.put(f"{BASE}/api/resumes/{created['id']}",
                     json=_make(title="全栈开发-更新"), timeout=10)
    assert r.status_code == 200
    assert r.json()["title"] == "全栈开发-更新"
    assert r.json()["id"] == created["id"]


def test_delete():
    """删除简历 → 200，删后查 404"""
    created = requests.post(f"{BASE}/api/resumes", json=_make(), timeout=10).json()
    r = requests.delete(f"{BASE}/api/resumes/{created['id']}", timeout=10)
    assert r.status_code == 200
    assert r.json()["ok"] is True
    assert requests.get(f"{BASE}/api/resumes/{created['id']}", timeout=10).status_code == 404


def test_delete_not_found():
    """删不存在的简历 → 404"""
    r = requests.delete(f"{BASE}/api/resumes/not-exist", timeout=10)
    assert r.status_code == 404
