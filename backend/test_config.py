"""Tests for configuration loader."""

import os


def test_deep_merge():
    """Test deep merge function."""
    from config import deep_merge
    
    base = {
        "a": 1,
        "b": {"c": 2, "d": 3}
    }
    override = {
        "b": {"c": 10, "e": 4},
        "f": 5
    }
    
    result = deep_merge(base, override)
    
    assert result["a"] == 1
    assert result["b"]["c"] == 10  # overridden
    assert result["b"]["d"] == 3   # preserved
    assert result["b"]["e"] == 4   # added
    assert result["f"] == 5        # added


def test_load_config_without_yaml():
    """Test loading config with no YAML file (uses defaults)."""
    from config import load_config, get_config
    
    # Clear cache
    if hasattr(get_config, '_config'):
        delattr(get_config, '_config')
    
    config = load_config()
    
    # Check defaults exist
    assert "inference" in config
    assert "memory" in config
    assert "server" in config
    assert "system_prompt" in config
    
    # Check default values
    assert config["inference"]["endpoint_url"] == "http://<inference-host>:1234/v1"
    assert config["inference"]["model_id"] == "qwen/qwen3-coder-next"
    assert config["server"]["backend_port"] == 8000


def test_env_override():
    """Test environment variable overrides."""
    from config import load_config, get_config
    
    # Clear cache
    if hasattr(get_config, '_config'):
        delattr(get_config, '_config')
    
    # Set env vars
    os.environ["LLM_ENDPOINT"] = "http://env-endpoint:1234/v1"
    os.environ["DB_PATH"] = "/tmp/test.db"
    
    try:
        config = load_config()
        
        assert config["inference"]["endpoint_url"] == "http://env-endpoint:1234/v1"
        assert config["memory"]["db_path"] == "/tmp/test.db"
    finally:
        # Clean up env vars
        if "LLM_ENDPOINT" in os.environ:
            del os.environ["LLM_ENDPOINT"]
        if "DB_PATH" in os.environ:
            del os.environ["DB_PATH"]


def test_singleton_pattern():
    """Test that get_config caches the configuration."""
    from config import get_config
    
    config1 = get_config()
    config2 = get_config()
    
    assert config1 is config2


if __name__ == "__main__":
    test_deep_merge()
    print("✓ deep_merge test passed")
    
    test_load_config_without_yaml()
    print("✓ load_config without yaml test passed")
    
    test_env_override()
    print("✓ env override test passed")
    
    test_singleton_pattern()
    print("✓ singleton pattern test passed")
    
    print("\n✓ All config tests passed!")
