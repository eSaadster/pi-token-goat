"""Shared test fixtures."""
from unittest.mock import patch

import pytest

import cc_saver.paths as paths


@pytest.fixture
def tmp_data_dir(tmp_path):
    """Monkeypatch cc_saver.paths.data_dir to a temporary directory."""
    with patch.object(paths, 'data_dir', return_value=tmp_path):
        yield tmp_path
