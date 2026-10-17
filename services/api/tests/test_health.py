from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_endpoint_reports_api_status() -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "continuum-api",
        "version": "0.1.0",
    }


def test_root_endpoint_is_scaffold_only() -> None:
    response = client.get("/")
    assert response.status_code == 200
    assert response.json()["status"] == "scaffold"
