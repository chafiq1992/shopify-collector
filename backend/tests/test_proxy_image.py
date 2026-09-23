"""/api/proxy-image must only read the allowlisted bucket.

It attaches this app's own GCS credentials and is reachable anonymously (the
frontend uses it as an <img src>), so without an allowlist it reads any bucket
the service account can reach, for anyone.
"""
import pytest
from fastapi.testclient import TestClient

from backend.app import main


ALLOWED = [
    "https://storage.googleapis.com/whatsappinbox/screens/abc.jpg",
    "https://storage.googleapis.com/whatsappinbox/a/b/c/d.png?x=1",
    "https://storage.googleapis.com/whatsappinbox/name%20with%20space.jpg",
]

REFUSED = [
    # another bucket - the whole point
    "https://storage.googleapis.com/some-other-bucket/secret.json",
    # prefix tricks a startswith() check would have let through
    "https://storage.googleapis.com/whatsappinbox.evil/x.jpg",
    "https://storage.googleapis.com/whatsappinbox-backup/x.jpg",
    # traversal out of the bucket, plain and percent-encoded
    "https://storage.googleapis.com/whatsappinbox/../other/x.jpg",
    "https://storage.googleapis.com/whatsappinbox/%2e%2e/other/x.jpg",
    "https://storage.googleapis.com/whatsappinbox/./x.jpg",
    "https://storage.googleapis.com/whatsappinbox/a%5c..%5cother/x.jpg",
    # bucket listing, not an object
    "https://storage.googleapis.com/whatsappinbox/",
    "https://storage.googleapis.com/whatsappinbox",
    # wrong scheme, host, port, userinfo
    "http://storage.googleapis.com/whatsappinbox/x.jpg",
    "https://storage.googleapis.com.evil.test/whatsappinbox/x.jpg",
    "https://evil.test/storage.googleapis.com/whatsappinbox/x.jpg",
    "https://storage.googleapis.com:8443/whatsappinbox/x.jpg",
    "https://user@storage.googleapis.com/whatsappinbox/x.jpg",
    "",
]


@pytest.mark.parametrize("url", ALLOWED)
def test_allowlisted_bucket_objects_are_allowed(url):
    assert main._proxy_image_url_allowed(url)


@pytest.mark.parametrize("url", REFUSED)
def test_everything_else_is_refused(url):
    assert not main._proxy_image_url_allowed(url)


@pytest.mark.parametrize("url", [u for u in REFUSED if u])
def test_endpoint_refuses_before_making_any_request(url, monkeypatch):
    """A refused URL must be rejected before the GCS token is even fetched."""

    async def _boom():
        raise AssertionError("must not fetch a GCS token for a refused URL")

    monkeypatch.setattr(main, "_gcs_access_token", _boom)
    resp = TestClient(main.app).get("/api/proxy-image", params={"url": url})
    assert resp.status_code == 400
