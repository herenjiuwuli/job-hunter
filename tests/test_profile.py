"""接口测试：候选人画像（/api/profile）—— applypilot 方法论吸收产物"""
import requests

BASE = "http://localhost:3100"


def test_get_default():
    """无画像时返回默认模板结构"""
    r = requests.get(f"{BASE}/api/profile", timeout=10)
    assert r.status_code == 200
    data = r.json()
    assert data["basic"]["name"] == ""
    assert data["workAuthorization"]["country"] == "中国"
    assert data["selfIdentification"]["strategy"] == "prefer_not_to_say"


def test_save_and_read():
    """保存画像 → 能读回，且未传字段用默认值兜底"""
    payload = {
        "basic": {"name": "晨", "email": "test@example.com", "location": "广州"},
        "workAuthorization": {"currentAuthorization": "中国大陆，无需额外授权"},
        "targets": {"primaryRoles": ["前端开发", "全栈开发"], "rolesToAvoid": ["销售"]},
        "compensation": {"baseRange": "8k-12k/月"},
    }
    r = requests.put(f"{BASE}/api/profile", json=payload, timeout=10)
    assert r.status_code == 200
    saved = r.json()
    assert saved["basic"]["name"] == "晨"
    assert saved["targets"]["primaryRoles"] == ["前端开发", "全栈开发"]
    # 未传的字段被默认值补齐
    assert saved["basic"]["github"] == ""
    assert saved["selfIdentification"]["strategy"] == "prefer_not_to_say"
    assert saved["targets"]["remotePreference"] == ""

    r2 = requests.get(f"{BASE}/api/profile", timeout=10)
    assert r2.json()["basic"]["email"] == "test@example.com"


def test_save_partial_merges():
    """只传部分字段 → 内层对象浅合并，不整段丢失"""
    full = {
        "basic": {"name": "晨", "email": "a@b.c", "phone": "123", "location": "广州"},
        "targets": {"primaryRoles": ["前端"], "targetLocations": ["广州"]},
    }
    requests.put(f"{BASE}/api/profile", json=full, timeout=10)

    # 只更新 basic.name，targets 不应被清空
    r = requests.put(f"{BASE}/api/profile",
                     json={"basic": {"name": "晨晨"}}, timeout=10)
    data = r.json()
    assert data["basic"]["name"] == "晨晨"
    assert data["basic"]["email"] == "a@b.c"  # 未传的 basic 字段保留
    assert data["targets"]["primaryRoles"] == ["前端"]  # targets 未传 → 保留
