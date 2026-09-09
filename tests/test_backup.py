"""接口测试：数据备份/恢复（/api/backup/export|import）—— 自用工具防数据丢失"""
import requests

BASE = "http://localhost:3100"


def test_export_empty_defaults():
    """无任何数据时导出：返回结构完整，个人数据用空值兜底"""
    r = requests.get(f"{BASE}/api/backup/export", timeout=10)
    assert r.status_code == 200
    body = r.json()
    assert body["app"] == "job-hunter"
    assert body["version"] == 1
    assert "exportedAt" in body
    assert body["data"]["resumes"] == []
    assert body["data"]["applications"] == []
    assert body["data"]["records"] == []
    assert body["data"]["profile"] == {}


def test_export_includes_seeded_data():
    """先造一条投递记录 → 导出应包含它"""
    requests.post(f"{BASE}/api/applications", json={
        "company": "测试公司", "jobTitle": "测试岗位", "status": "已投递",
    }, timeout=10)
    r = requests.get(f"{BASE}/api/backup/export", timeout=10)
    data = r.json()["data"]
    assert len(data["applications"]) == 1
    assert data["applications"][0]["company"] == "测试公司"


def test_import_missing_data_400():
    """缺少 data 字段 → 400"""
    r = requests.post(f"{BASE}/api/backup/import", json={"app": "job-hunter"}, timeout=10)
    assert r.status_code == 400


def test_import_wrong_type_400():
    """data.resumes 应为数组、传对象 → 400，且不写入任何数据"""
    r = requests.post(f"{BASE}/api/backup/import", json={
        "data": {"resumes": {"not": "array"}},
    }, timeout=10)
    assert r.status_code == 400
    # 校验失败不应留下损坏文件
    r2 = requests.get(f"{BASE}/api/backup/export", timeout=10)
    assert r2.json()["data"]["resumes"] == []


def test_import_restores_data():
    """导入备份 → 数据被写入，可再导出读回（恢复闭环）"""
    payload = {
        "app": "job-hunter",
        "version": 1,
        "data": {
            "resumes": [{"id": "r1", "title": "测试简历", "name": "晨", "phone": "1", "email": "a@b.c"}],
            "applications": [{"id": "a1", "company": "恢复公司", "jobTitle": "恢复岗位"}],
            "records": [],
            "profile": {"basic": {"name": "晨"}},
        },
    }
    r = requests.post(f"{BASE}/api/backup/import", json=payload, timeout=10)
    assert r.status_code == 200
    assert "resumes" in r.json()["imported"]

    r2 = requests.get(f"{BASE}/api/backup/export", timeout=10)
    data = r2.json()["data"]
    assert data["resumes"][0]["title"] == "测试简历"
    assert data["applications"][0]["company"] == "恢复公司"
    assert data["profile"]["basic"]["name"] == "晨"
