"""接口测试：投递追踪（/api/applications）—— job-hunter 独有"""
import requests

BASE = "http://localhost:3100"


def _make(company="测试公司", jobTitle="前端开发实习生", **kw):
    d = {"company": company, "jobTitle": jobTitle, "platform": "实习僧", "status": "待投递"}
    d.update(kw)
    return d


def test_create_missing_company():
    """缺公司名 → 400"""
    r = requests.post(f"{BASE}/api/applications", json={"jobTitle": "前端"}, timeout=10)
    assert r.status_code == 400


def test_create_missing_jobtitle():
    """缺岗位名 → 400"""
    r = requests.post(f"{BASE}/api/applications", json={"company": "测试公司"}, timeout=10)
    assert r.status_code == 400


def test_create_and_list():
    """正常创建 → 200，默认状态待投递，列表能查到"""
    r = requests.post(f"{BASE}/api/applications", json=_make(), timeout=10)
    assert r.status_code == 200
    data = r.json()
    assert data["id"]
    assert data["status"] == "待投递"

    r2 = requests.get(f"{BASE}/api/applications", timeout=10)
    assert any(x["id"] == data["id"] for x in r2.json())


def test_invalid_status_defaults():
    """非法状态 → 重置为「待投递」"""
    r = requests.post(f"{BASE}/api/applications", json=_make(status="不存在的状态"), timeout=10)
    assert r.status_code == 200
    assert r.json()["status"] == "待投递"


def test_status_transition():
    """合法状态流转：待投递 → 已面试"""
    created = requests.post(f"{BASE}/api/applications", json=_make(), timeout=10).json()
    r = requests.put(f"{BASE}/api/applications/{created['id']}",
                     json=_make(status="已面试"), timeout=10)
    assert r.status_code == 200
    assert r.json()["status"] == "已面试"


def test_update_not_found():
    """更新不存在的投递 → 404"""
    r = requests.put(f"{BASE}/api/applications/not-exist", json=_make(), timeout=10)
    assert r.status_code == 404


def test_delete():
    """删除投递 → 200"""
    created = requests.post(f"{BASE}/api/applications", json=_make(), timeout=10).json()
    r = requests.delete(f"{BASE}/api/applications/{created['id']}", timeout=10)
    assert r.status_code == 200
    assert r.json()["ok"] is True
