"""Generate cloud_config.py at packaging time from CI secrets."""
import base64
import json
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
    lowered = key.lower()
    if lowered.startswith(("service_role", "sb_secret_")) or "secret" in lowered:
        raise SystemExit("Only the public Supabase publishable/anon key may ship in the desktop app.")
    # Legacy Supabase anon/service-role keys are JWTs. Inspect their claims too,
    # so a mistakenly selected service-role token cannot get embedded in an installer.
    segments = key.split(".")
    if len(segments) == 3:
        try:
            payload_segment = segments[1]
            payload_segment += "=" * (-len(payload_segment) % 4)
            claims = json.loads(base64.urlsafe_b64decode(payload_segment.encode("ascii")))
            if claims.get("role") in {"service_role", "supabase_admin"}:
                raise SystemExit("A privileged Supabase JWT cannot be embedded in the desktop app.")
        except (ValueError, UnicodeError, json.JSONDecodeError):
            # Publishable tokens need not be JWTs. Unknown encodings are not treated
            # as privileged solely because they do not decode like a JWT.
            pass
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
