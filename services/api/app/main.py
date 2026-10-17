"""Minimal API foundation; persistent project features are added in later phases."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(
    title="CONTINUUM API",
    version="0.1.0",
    description="Initial health endpoint. Project APIs and authentication are not yet implemented.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["Content-Type"],
)


@app.get("/api/health", tags=["system"])
def health() -> dict[str, str]:
    """Report that the API process is reachable."""
    return {"status": "ok", "service": "continuum-api", "version": "0.1.0"}


@app.get("/", include_in_schema=False)
def root() -> dict[str, str]:
    return {
        "name": "CONTINUUM API",
        "status": "scaffold",
        "docs": "/docs",
    }
