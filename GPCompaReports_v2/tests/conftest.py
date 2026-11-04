"""Shared fixtures.

One Playwright driver per pytest session. Each browser test module launches its own
Chromium from it; two separate sync_playwright() contexts in one process fail with
"Sync API inside the asyncio loop".
"""
import pytest


@pytest.fixture(scope='session')
def playwright_session():
    sync_api = pytest.importorskip('playwright.sync_api')
    with sync_api.sync_playwright() as p:
        yield p
