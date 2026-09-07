"""pytest 全局配置：每个测试函数前后清空运行时数据，保证测试隔离、可重复跑。

只清「运行时数据」，保留 jobs.json（岗位知识库，apply/interview 测试依赖它）。
后端每次请求都实时读文件，删文件后读到空数组，故此清理安全。
"""
import os
import pytest

DATA_DIR = os.path.join(os.path.dirname(__file__), '..', 'server', 'data')

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
