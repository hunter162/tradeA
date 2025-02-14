import pytest
import os

def pytest_configure(config):
    """
    测试配置初始化
    """
    # 创建测试结果目录
    os.makedirs("tests/results", exist_ok=True)
    os.makedirs("tests/assets", exist_ok=True)

@pytest.fixture(scope="session", autouse=True)
def setup_environment():
    """
    设置测试环境
    """
    # 检查环境变量
    required_env_vars = ["HELIUS_RPC_URL"]
    missing_vars = [var for var in required_env_vars if not os.getenv(var)]
    
    if missing_vars:
        pytest.fail(f"缺少必要的环境变量: {', '.join(missing_vars)}") 