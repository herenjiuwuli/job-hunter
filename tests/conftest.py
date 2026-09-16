"""pytest 全局配置：
1. 会话前置检查：强制 mock AI + 隔离数据目录，防止误打真实 API / 污染真实数据。
2. 每个测试函数前后清空运行时数据，保证测试隔离、可重复跑。

只清「运行时数据」，保留 jobs.json（岗位知识库，apply/interview 测试依赖它）。
后端每次请求都实时读文件，删文件后读到空数组，故此清理安全。
"""
import os
import pytest
import requests

BASE = os.environ.get("JH_BASE", "http://localhost:3100")

# 数据目录与后端 store.js 逻辑保持一致：JOB_HUNTER_DATA_DIR 优先（测试隔离）
DATA_DIR = os.environ.get("JOB_HUNTER_DATA_DIR") or os.path.join(
    os.path.dirname(__file__), '..', 'server', 'data'
)

# 运行时数据文件（可清）；jobs.json 是知识库，绝不删
RUNTIME_FILES = ('resumes.json', 'applications.json', 'records.json', 'profile.json')


def _clear():
    for name in RUNTIME_FILES:
        p = os.path.join(DATA_DIR, name)
        if os.path.exists(p):
            os.remove(p)


@pytest.fixture(autouse=True)
def clean_runtime_data():
    _clear()
    yield
    _clear()


def _check_test_env():
    """会话开始前确认后端是「mock AI + 隔离数据目录」，否则终止整个会话（不执行任何用例）。"""
    try:
        h = requests.get(f"{BASE}/api/health", timeout=5).json()
    except Exception as e:
        pytest.exit(
            f"后端不可达 {BASE}: {e}\n请按 TESTING.md 启动「mock + 隔离数据目录」的后端",
            returncode=1,
        )
    if h.get("aiMock") is not True:
        pytest.exit(
            f"当前后端连的是真实 AI（会花钱且结果不稳定）：{h}\n"
            "请用 DEEPSEEK_BASE_URL=http://127.0.0.1:9999 启动后端",
            returncode=1,
        )
    if h.get("dataDirIsolated") is not True:
        pytest.exit(
            f"当前后端未隔离数据目录（会污染真实数据）：{h}\n"
            "请用 JOB_HUNTER_DATA_DIR=<临时目录> 启动后端",
            returncode=1,
        )
    # 防误删：pytest 进程必须与后端用同一隔离目录，否则下方 clean_runtime_data 会清错地方
    if not os.environ.get("JOB_HUNTER_DATA_DIR"):
        pytest.exit(
            "pytest 进程未设置 JOB_HUNTER_DATA_DIR：运行时数据清理将误删真实 server/data/。\n"
            "请用与后端相同的 JOB_HUNTER_DATA_DIR 环境变量启动 pytest（见 TESTING.md）",
            returncode=1,
        )


def pytest_sessionstart(session):
    _check_test_env()
