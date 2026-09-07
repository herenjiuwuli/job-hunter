"""假的 DeepSeek 服务器（mock）——测试用，返回固定 JSON，不花钱不联网。
启动：python tests/mock_deepseek.py   （默认监听 127.0.0.1:9999，可用环境变量 MOCK_PORT 覆盖）
后端需带环境变量启动：DEEPSEEK_BASE_URL=http://127.0.0.1:9999 node server/dev.js
"""
from http.server import HTTPServer, BaseHTTPRequestHandler
import json
import os


def build_content(body_str):
    """根据请求内容返回对应的假 JSON（各接口 system prompt 特征不同）"""
    if "资深 HR" in body_str or "简历分析" in body_str:
        return json.dumps({
            "matchScores": [
                {"name": "技术能力", "score": 70, "comment": "有全栈基础"},
                {"name": "项目经验", "score": 60, "comment": "项目偏少"},
                {"name": "岗位匹配", "score": 65, "comment": "匹配中等"},
                {"name": "表达结构", "score": 75, "comment": "结构清晰"},
            ],
            "highlights": ["掌握 Vue3/Node.js", "有 pytest 测试实践"],
            "weaknesses": ["项目深度不足"],
            "predictedQuestions": ["介绍一下你的项目", "Vue3 响应式原理", "讲讲你的测试实践"],
            "recommendJobs": [
                {"name": "前端开发", "score": 72, "reason": "技能匹配"},
                {"name": "自动化测试", "score": 65, "reason": "有测试意识"},
                {"name": "后端开发", "score": 58, "reason": "有 Node 基础"},
                {"name": "数据分析", "score": 40, "reason": "相关经验少"},
                {"name": "产品运营", "score": 35, "reason": "关联较弱"},
            ],
        }, ensure_ascii=False)

    if "面试现在开始" in body_str:
        return json.dumps({"firstQuestion": "请先做个自我介绍"}, ensure_ascii=False)

    if "复盘报告" in body_str:
        return json.dumps({
            "totalScore": 78,
            "dimensions": [
                {"name": "表达清晰度", "score": 80},
                {"name": "技术深度", "score": 70},
                {"name": "逻辑性", "score": 85},
                {"name": "岗位匹配度", "score": 75},
            ],
            "perQuestion": [{"q": "自我介绍", "score": 80, "comment": "结构不错"}],
            "suggestions": ["多讲项目细节", "补充数据支撑"],
            "keyPoints": ["提前准备项目故事"],
            "otherJobs": ["测试开发", "DevOps"],
        }, ensure_ascii=False)

    if "简历顾问" in body_str:
        return json.dumps({
            "resumeText": "## 教育背景\n**XX大学** 计算机专业（本科）  2021.09 - 2025.06\n\n## 专业技能\n- **Vue3**、Node.js、Python\n\n## 项目经历\n- **AI 热点选题助手**（负责人）  2026.01 - 至今",
            "versions": [
                {"job": "前端开发", "text": "## 教育背景\n**XX大学** 计算机专业（本科）\n\n## 专业技能\n- **Vue3** 组件化开发"},
                {"job": "自动化测试", "text": "## 教育背景\n**XX大学** 计算机专业（本科）\n\n## 专业技能\n- **pytest** 接口测试"},
            ],
        }, ensure_ascii=False)

    # tailor 接口（job-hunter 独有）：system prompt 含「简历优化专家」
    # 注意必须放在「求职顾问」分支之前，否则会误命中 apply 的返回结构
    if "简历优化专家" in body_str:
        return json.dumps({
            "greeting": "你好，我是晨，看到贵司的岗位很感兴趣，我有 Vue3 + Node 全栈项目经验，能快速上手。",
            "coverLetter": "尊敬的招聘负责人：您好！我是一名计算机专业应届生，有全栈项目实践，期待有机会面聊。",
            "tailoredResume": "## 教育背景\n**XX大学** 计算机专业（本科）\n\n## 专业技能\n- **Vue3**、Node.js、Express\n\n## 项目经历\n- **MCN 数据工具**（负责人）\n\n## 自我评价\n踏实、能快速上手。",
            "matchPoints": ["匹配点1：Vue3 项目经验对口", "匹配点2：全栈开发能力", "匹配点3：具备测试意识"],
        }, ensure_ascii=False)

    if "求职顾问" in body_str:
        return json.dumps({
            "applyList": [
                {"company": "中大型电商平台", "reason": "前端需求多"},
                {"company": "SaaS 软件公司", "reason": "全栈适用"},
            ],
            "greeting": "您好，我有 Vue3 全栈项目经验，想应聘前端开发岗位。",
            "coverLetter": "尊敬的招聘负责人：您好！我是一名计算机专业应届生……",
        }, ensure_ascii=False)

    if "FOLLOWUP" in body_str:
        # 测试追问场景：AI 标记 isFollowUp=true，追问问题
        return json.dumps({
            "comment": "这个点值得深入聊聊",
            "score": 75,
            "referencePoints": ["要点1：结合项目讲", "要点2：给出数据", "要点3：说明取舍"],
            "nextQuestion": "你说解决了性能问题，具体是怎么做的？",
            "isFollowUp": True,
        }, ensure_ascii=False)

    # 默认：interview/answer 的点评 + 即时评分 + 参考要点 + 下一题
    return json.dumps({
        "comment": "回答得不错，逻辑清晰，可以再具体一些。",
        "score": 82,
        "referencePoints": ["要点1：先给结论再展开", "要点2：用项目实例支撑", "要点3：补充数据/量化结果"],
        "nextQuestion": "请讲讲你的项目难点",
        "isFollowUp": False,
    }, ensure_ascii=False)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length).decode("utf-8", "replace")
        content = build_content(raw)
        body = json.dumps({"choices": [{"message": {"content": content}}]}, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass  # 静默


if __name__ == "__main__":
    PORT = int(os.environ.get("MOCK_PORT", "9999"))
    print(f"假 DeepSeek 服务器运行中: http://127.0.0.1:{PORT}")
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
