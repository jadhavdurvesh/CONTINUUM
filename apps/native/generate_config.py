"""Generate cloud_config.py at packaging time from CI secrets."""
import os
from pathlib import Path
from urllib.parse import urlparse

def main():
    api = os.environ.get("CONTINUUM_CLOUD_API_URL", "").strip().rstrip("/")
    supabase = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
    key = os.environ.get("SUPABASE_PUBLISHABLE_KEY", "").strip()
    for label, value in (("CONTINUUM_CLOUD_API_URL", api), ("SUPABASE_URL", supabase), ("SUPABASE_PUBLISHABLE_KEY", key)):
        if not value:
            raise SystemExit("Missing required build secret: " + label)
    for label, value in (("CONTINUUM_CLOUD_API_URL", api), ("SUPABASE_URL", supabase)):
        parsed = urlparse(value)
        if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
            raise SystemExit(label + " must be a valid HTTPS URL.")
    if key.lower().startswith("service_role") or "secret" in key.lower():
        raise SystemExit("Only the public Supabase publishable/anon key may ship in the desktop app.")
    target = Path(__file__).parent / "continuum" / "_release_cloud_config.py"
    target.write_text(
        '"""Generated during native desktop packaging. Do not hand-edit."""\n'
        + "SUPABASE_URL = " + repr(supabase) + "\n"
        + "SUPABASE_PUBLISHABLE_KEY = " + repr(key) + "\n"
        + "CLOUD_API_URL = " + repr(api) + "\n",
        encoding="utf-8",
    )
    print("Cloud endpoints embedded; no provider/service-role secrets were added to the desktop app.")

if __name__ == "__main__":
    main()
