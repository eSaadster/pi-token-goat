"""Tests for config.py — TOKEN_GOAT_WORKER_WATCHDOG and related worker env-var overrides."""
from __future__ import annotations


def _reset_cfg_cache() -> None:
    import token_goat.config as cfg_mod
    cfg_mod._config_mtime_cache = None


class TestWorkerWatchdogEnvVar:
    """TOKEN_GOAT_WORKER_WATCHDOG env var disables the watchdog_enabled flag."""

    def test_watchdog_enabled_by_default(self, tmp_path, monkeypatch):
        """With no env var, watchdog_enabled defaults to True."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text("", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        monkeypatch.delenv("TOKEN_GOAT_WORKER_WATCHDOG", raising=False)
        _reset_cfg_cache()

        cfg = cfg_mod.load()
        assert cfg.worker.watchdog_enabled is True

    def test_watchdog_disabled_by_env_zero(self, tmp_path, monkeypatch):
        """TOKEN_GOAT_WORKER_WATCHDOG=0 disables watchdog_enabled."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text("", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        monkeypatch.setenv("TOKEN_GOAT_WORKER_WATCHDOG", "0")
        _reset_cfg_cache()

        cfg = cfg_mod.load()
        assert cfg.worker.watchdog_enabled is False

    def test_watchdog_disabled_by_env_false(self, tmp_path, monkeypatch):
        """TOKEN_GOAT_WORKER_WATCHDOG=false disables watchdog_enabled."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text("", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        monkeypatch.setenv("TOKEN_GOAT_WORKER_WATCHDOG", "false")
        _reset_cfg_cache()

        cfg = cfg_mod.load()
        assert cfg.worker.watchdog_enabled is False

    def test_watchdog_disabled_by_env_no(self, tmp_path, monkeypatch):
        """TOKEN_GOAT_WORKER_WATCHDOG=no disables watchdog_enabled."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text("", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        monkeypatch.setenv("TOKEN_GOAT_WORKER_WATCHDOG", "no")
        _reset_cfg_cache()

        cfg = cfg_mod.load()
        assert cfg.worker.watchdog_enabled is False

    def test_watchdog_disabled_by_env_off(self, tmp_path, monkeypatch):
        """TOKEN_GOAT_WORKER_WATCHDOG=off disables watchdog_enabled."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text("", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        monkeypatch.setenv("TOKEN_GOAT_WORKER_WATCHDOG", "off")
        _reset_cfg_cache()

        cfg = cfg_mod.load()
        assert cfg.worker.watchdog_enabled is False

    def test_watchdog_toml_false_kept_without_env(self, tmp_path, monkeypatch):
        """TOML watchdog_enabled=false is respected when env var is absent."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text("[worker]\nwatchdog_enabled = false\n", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        monkeypatch.delenv("TOKEN_GOAT_WORKER_WATCHDOG", raising=False)
        _reset_cfg_cache()

        cfg = cfg_mod.load()
        assert cfg.worker.watchdog_enabled is False

    def test_watchdog_env_overrides_toml_true(self, tmp_path, monkeypatch):
        """Env var=0 overrides TOML watchdog_enabled=true."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text("[worker]\nwatchdog_enabled = true\n", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        monkeypatch.setenv("TOKEN_GOAT_WORKER_WATCHDOG", "0")
        _reset_cfg_cache()

        cfg = cfg_mod.load()
        assert cfg.worker.watchdog_enabled is False


class TestMalformedTomlFallsBackToDefaults:
    """Malformed TOML config falls back to all defaults without raising."""

    def test_malformed_toml_returns_default_config(self, tmp_path, monkeypatch):
        """A syntactically invalid TOML file yields a config with all defaults."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text("this is not valid toml = [[[\n", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        _reset_cfg_cache()

        # Must not raise — load() catches TOMLDecodeError and uses defaults.
        cfg = cfg_mod.load()

        # A sampling of defaults to confirm fallback worked:
        assert cfg.worker.watchdog_enabled is True
        assert cfg.worker.max_pool_workers == 4

    def test_malformed_toml_logs_warning(self, tmp_path, monkeypatch, caplog):
        """A malformed TOML file causes a warning log entry."""
        import logging

        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text("[broken\n", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        _reset_cfg_cache()

        with caplog.at_level(logging.WARNING, logger="token_goat.config"):
            cfg_mod.load()

        assert any("config load failed" in r.message or "load failed" in r.message for r in caplog.records), (
            f"expected a warning log about config load failure; got: {[r.message for r in caplog.records]}"
        )
