"""链路测试：简历库 → AI 生成 → 保存 content → 拉回验证 —— 模拟 ResumeBuilder.vue 的整条操作链

补的是「跨接口流程」覆盖，单接口测试在 test_resumes.py / test_resume.py 已存在。
"""
import requests

BASE = "http://localhost:3100"


def _basic_resume():
    """最小可用的简历库 POST payload"""
    return {
        "title": "前端开发·测试",
        "target": "前端开发",
        "basic": {
            "name": "测试候选人",
            "phone": "13800000000",
            "email": "test@example.com",
            "city": "杭州",
            "school": "XX大学",
            "major": "计算机",
            "education": "本科",
            "graduationYear": "2025.06",
        },
        "skills": ["Vue3", "Node.js", "Git"],
        "experiences": [],
        "projects": [
            {"name": "电商系统", "desc": "前后端独立开发", "highlights": ["Vue3 + Element Plus"]},
        ],
        "selfEvaluation": "",
        "content": "",
    }


def test_flow_create_get_generate_save():
    """完整链路：建简历 → 拉回 → AI 生成 → 更新 content（不改其他字段） → 再 GET 验证"""
    # 1) 创建空白简历（content 为空）
    create = requests.post(f"{BASE}/api/resumes", json=_basic_resume(), timeout=10)
    assert create.status_code == 200
    rid = create.json()["id"]
    assert create.json()["content"] == ""

    # 2) GET 拉回（ResumeBuilder.vue 进入页调 api.resumes.get(id)）
    detail = requests.get(f"{BASE}/api/resumes/{rid}", timeout=10)
    assert detail.status_code == 200
    got = detail.json()
    assert got["basic"]["name"] == "测试候选人"
    assert len(got["skills"]) == 3
    assert len(got["projects"]) == 1

    # 3) 调 AI 生成（ResumeBuilder.vue 的 generate() 用简历库 basic + 用户改过的 skills/projects）
    gen = requests.post(
        f"{BASE}/api/resume/generate",
        json={
            "basicInfo": {
                "name": got["basic"]["name"],
                "phone": got["basic"]["phone"],
                "email": got["basic"]["email"],
                "city": got["basic"]["city"],
                "skills": "Vue3, TypeScript, Node.js, Git",
                "projects": "电商系统：负责订单模块，独立完成前后端",
                "targetJobs": ["前端开发"],
            }
        },
        timeout=20,
    )
    assert gen.status_code == 200
    gen_data = gen.json()
    assert len(gen_data["resumeText"]) > 50        # mock 至少给出完整 markdown
    assert len(gen_data["versions"]) >= 1          # 至少有「前端开发」版

    # 4) 保存 content 回简历库（ResumeBuilder.vue 的 saveToLibrary()，不覆盖其他字段）
    payload = {**got, "content": gen_data["resumeText"]}
    save = requests.put(f"{BASE}/api/resumes/{rid}", json=payload, timeout=10)
    assert save.status_code == 200
    saved = save.json()
    assert len(saved["content"]) == len(gen_data["resumeText"])
    # 关键断言：basic / skills / projects 三个非 content 字段都被保留
    assert saved["basic"]["name"] == "测试候选人"
    assert saved["basic"]["phone"] == "13800000000"
    assert len(saved["skills"]) == 3
    assert len(saved["projects"]) == 1

    # 5) 再次拉回，确认 content 已落库且其他字段没动
    verify = requests.get(f"{BASE}/api/resumes/{rid}", timeout=10)
    assert verify.status_code == 200
    v = verify.json()
    assert len(v["content"]) == len(gen_data["resumeText"])
    assert v["basic"]["name"] == "测试候选人"

    # 清理
    requests.delete(f"{BASE}/api/resumes/{rid}", timeout=10)


def test_flow_partial_update_resets_unspecified_fields():
    """链路契约：简历库 PUT 是 Replace（不是 Merge），前端必须每次传完整 payload

    这个测试记录后端契约行为：未传的字段会被 sanitize 重置为默认值。
    防：未来某次改 sanitize 成 Merge 而破坏 ResumeBuilder.vue 的「整个 sourceResume 透传」写法。
    """
    create = requests.post(f"{BASE}/api/resumes", json=_basic_resume(), timeout=10)
    rid = create.json()["id"]

    # 只传最少的字段（id + content）。预期：未传字段回默认值（basic.name="" 等）
    save = requests.put(
        f"{BASE}/api/resumes/{rid}",
        json={"id": rid, "content": "## 新内容\n\n简历成品文本"},
        timeout=10,
    )
    assert save.status_code == 200
    saved = save.json()
    # Replace 语义：content 写入成功
    assert saved["content"] == "## 新内容\n\n简历成品文本"
    # Replace 语义：未传的 basic / skills / projects 等回到默认值（这正是契约）
    assert saved["basic"]["name"] == ""
    assert saved["skills"] == []
    assert saved["projects"] == []

    requests.delete(f"{BASE}/api/resumes/{rid}", timeout=10)


def test_flow_missing_id_returns_404():
    """链路：访问不存在的 id → 404（不是 500）"""
    r = requests.get(f"{BASE}/api/resumes/00000000-0000-0000-0000-000000000000", timeout=10)
    assert r.status_code == 404
