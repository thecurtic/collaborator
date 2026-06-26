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


def test_dot_config_yaml_override():
    """Test that .config.yaml overrides config.yaml with deep merge."""
    import tempfile
    from config import deep_merge
    
    # Clear cache
    if hasattr(__import__('config', fromlist=['get_config']), 'get_config'):
        if hasattr(__import__('config', fromlist=['get_config']).get_config, '_config'):
            delattr(__import__('config', fromlist=['get_config']).get_config, '_config')
    
    # Create a temporary directory with config.yaml and .config.yaml
    with tempfile.TemporaryDirectory() as tmpdir:
        # Create config.yaml with shared settings
        config_yaml_path = os.path.join(tmpdir, "config.yaml")
        with open(config_yaml_path, 'w') as f:
            f.write("""
inference:
  endpoint_url: "http://shared-endpoint:1234/v1"
  model_id: "shared-model"
  temperature: 0.5
  max_tokens: 1024

server:
  backend_port: 8001
  cors_origins:
    - "http://shared-origin.com"
""")
        
        # Create .config.yaml with machine-specific overrides
        dot_config_yaml_path = os.path.join(tmpdir, ".config.yaml")
        with open(dot_config_yaml_path, 'w') as f:
            f.write("""
memory:
  db_path: "/tmp/machine-specific.db"

server:
  cors_origins:
    - "http://localhost:3000"
    - "https://production.com"
  backend_port: 9000
""")
        
        # Manually test the merge logic (same as load_config does)
        import yaml
        with open(config_yaml_path, 'r') as f:
            file_config = yaml.safe_load(f) or {}
        
        with open(dot_config_yaml_path, 'r') as f:
            dot_config = yaml.safe_load(f) or {}
        
        config = file_config.copy()
        if dot_config:
            config = deep_merge(config, dot_config)
        
        # Check that config.yaml values are present (inference not overridden)
        assert config["inference"]["endpoint_url"] == "http://shared-endpoint:1234/v1"
        assert config["inference"]["model_id"] == "shared-model"
        assert config["inference"]["temperature"] == 0.5
        
        # Check that .config.yaml overrides server.backend_port
        assert config["server"]["backend_port"] == 9000
        
        # Check that .config.yaml overrides server.cors_origins
        assert config["server"]["cors_origins"] == ["http://localhost:3000", "https://production.com"]
        
        # Check that .config.yaml overrides memory.db_path
        assert config["memory"]["db_path"] == "/tmp/machine-specific.db"


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
    
    test_dot_config_yaml_override()
    print("✓ .config.yaml override test passed")
    
    test_env_override()
    print("✓ env override test passed")
    
    test_singleton_pattern()
    print("✓ singleton pattern test passed")
    
    print("\n✓ All config tests passed!")
