"""
打招呼语接口的契约测试。

背景：BOSS 的「投递」＝发出那条消息，所以话术是投递的前置条件。
以前话术只能手动粘进扩展弹窗，网页端「AI 定制」为每个岗位生成的那条扩展拿不到。
这个接口就是让扩展自己去取 —— 取错了（取到别人的、取到没替换占位符的原文）
比没有更糟：会直接把错话发出去。

守三条：
  1. 定制话术优先于默认话术（默认是兜底，不是覆盖）
  2. 占位符必须替换掉，且替换后**不能**再把原文当话术返回
  3. 一人一份，别人存的话术不能被我取到
"""
import requests
from conftest import BASE, auth_headers


def _app(**kw):
    body = {"company": "测试公司", "jobTitle": "数据运营实习", "platform": "BOSS直聘", "status": "已投递"}
    body.update(kw)
    r = requests.post(f"{BASE}/api/applications", json=body, timeout=10)
    assert r.status_code == 200, r.text
    return r.json()


def _greet(company=None, jobTitle=None, who="owner"):
    params = {}
    if company:
        params["company"] = company
    if jobTitle:
        params["jobTitle"] = jobTitle
    return requests.get(f"{BASE}/api/greeting", params=params, headers=auth_headers(who), timeout=10)


def _save_default(text, who="owner"):
    return requests.put(
        f"{BASE}/api/greeting/default", json={"text": text}, headers=auth_headers(who), timeout=10
    )


def test_default_is_empty_before_set():
    r = _greet()
    assert r.status_code == 200
    assert r.json()["text"] == ""
    assert r.json()["source"] == ""


def test_default_greeting_replaces_placeholders():
    """默认话术里的 {{公司}}/{{岗位}} 必须换成真实值 —— 带花括号发出去是事故"""
    _save_default("您好，看到贵司的{{岗位}}，我是计算机应用工程大四在读。")
    d = _greet("正浩创新", "数据运营实习生").json()
    assert d["source"] == "default"
    assert "数据运营实习生" in d["text"]
    assert "{{" not in d["text"], f"占位符没替换：{d['text']}"


def test_application_greeting_wins_over_default():
    """这条投递自己生成过话术就用它 —— 默认话术只是兜底"""
    _save_default("默认话术{{岗位}}")
    _app(company="正浩创新", jobTitle="数据运营实习生", greeting="这是给正浩定制的")
    d = _greet("正浩创新", "数据运营实习生").json()
    assert d["source"] == "application"
    assert d["text"] == "这是给正浩定制的"


def test_matching_tolerates_platform_suffix():
    """平台上的标题常带尾巴（「…实习招聘」），取话术不能因此漏掉"""
    _save_default("")
    _app(company="法雷奥", jobTitle="台架测试实习生", greeting="法雷奥的定制话术")
    d = _greet("法雷奥", "台架测试实习生实习招聘").json()
    assert d["source"] == "application"
    assert d["text"] == "法雷奥的定制话术"


def test_greeting_is_per_user():
    """别人存的话术我取不到（否则会把同事的话发给 HR）"""
    _save_default("owner 的默认话术")
    other = _greet(who="intruder")
    assert other.status_code == 200
    assert other.json()["text"] == "", "别的账号看到了我的默认话术"
