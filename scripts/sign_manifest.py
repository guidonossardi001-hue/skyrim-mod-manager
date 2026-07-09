#!/usr/bin/env python3
"""
Sign a remote catalog manifest with Ed25519 (producer / CI side).

The client (electron/delta/manifest.ts) verifies the detached signature against a
PINNED public key, rejects any manifest whose release_counter is not strictly
greater than the last accepted one (anti-replay/downgrade), and restricts every
download_url to an allow-listed host. This script produces the signed envelope.

CRITICAL — canonicalization MUST match the JS verifier byte-for-byte:
  json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
and the manifest MUST NOT contain floating-point numbers (JS/Python format them
differently). Use ints and strings only (file_id:int, version:str, counter:int).

Usage:
  python sign_manifest.py keygen  priv.pem  pub.pem
  python sign_manifest.py sign    manifest.json  priv.pem  manifest.signed.json
  python sign_manifest.py verify  manifest.signed.json  pub.pem
"""
import sys
import json
import hashlib
from datetime import datetime, timezone

try:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import (
        Ed25519PrivateKey, Ed25519PublicKey,
    )
    from cryptography.hazmat.primitives import serialization
    from cryptography.exceptions import InvalidSignature
except ImportError:
    sys.exit("Manca 'cryptography'. Installa con:  pip install cryptography")


def canonical(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _reject_floats(obj, path="$"):
    if isinstance(obj, float):
        sys.exit(f"Float non ammesso nel manifest firmato: {path}={obj} (usa int/str)")
    if isinstance(obj, dict):
        for k, v in obj.items():
            _reject_floats(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            _reject_floats(v, f"{path}[{i}]")


def keygen(priv_path: str, pub_path: str):
    key = Ed25519PrivateKey.generate()
    with open(priv_path, "wb") as f:
        f.write(key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        ))
    with open(pub_path, "wb") as f:
        f.write(key.public_key().public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        ))
    print(f"keypair generato → {priv_path} / {pub_path}")
    print("Incolla il contenuto della chiave PUBBLICA in PINNED_PUBLIC_KEY_PEM (electron/delta/engine.ts)")


def sign(manifest_path: str, key_path: str, out_path: str):
    manifest = json.load(open(manifest_path, encoding="utf-8"))
    _reject_floats(manifest)
    # bump the monotonic anti-replay counter and stamp publish time
    manifest["release_counter"] = int(manifest.get("release_counter", 0)) + 1
    manifest["published_at"] = datetime.now(timezone.utc).isoformat()

    payload = canonical(manifest)
    digest = hashlib.sha256(payload).hexdigest()
    key = serialization.load_pem_private_key(open(key_path, "rb").read(), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        sys.exit("La chiave fornita non è Ed25519")
    sig = key.sign(payload).hex()

    envelope = {"manifest": manifest, "sha256": digest, "sig_ed25519": sig}
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(envelope, f, ensure_ascii=False, separators=(",", ":"))
    print(f"firmato → {out_path}  (counter={manifest['release_counter']}, sha256={digest[:12]}…, mods={len(manifest.get('mods', []))})")


def verify(signed_path: str, pub_path: str):
    env = json.load(open(signed_path, encoding="utf-8"))
    payload = canonical(env["manifest"])
    if hashlib.sha256(payload).hexdigest() != env["sha256"]:
        sys.exit("FAIL: hash non coerente")
    pub = serialization.load_pem_public_key(open(pub_path, "rb").read())
    if not isinstance(pub, Ed25519PublicKey):
        sys.exit("La chiave pubblica non è Ed25519")
    try:
        pub.verify(bytes.fromhex(env["sig_ed25519"]), payload)
    except InvalidSignature:
        sys.exit("FAIL: firma non valida")
    print(f"OK: firma valida (counter={env['manifest'].get('release_counter')})")


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    cmd = sys.argv[1]
    if cmd == "keygen" and len(sys.argv) == 4:
        keygen(sys.argv[2], sys.argv[3])
    elif cmd == "sign" and len(sys.argv) == 5:
        sign(sys.argv[2], sys.argv[3], sys.argv[4])
    elif cmd == "verify" and len(sys.argv) == 4:
        verify(sys.argv[2], sys.argv[3])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
