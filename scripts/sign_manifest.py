#!/usr/bin/env python3
"""
Sign a remote catalog manifest with Ed25519 (producer / CI side).

The client (electron/delta/manifest.ts) verifies the detached signature against a
PINNED public key, rejects any manifest whose release_counter is not strictly
greater than the last accepted one (anti-replay/downgrade), and restricts every
download_url to an allow-listed host. This script produces the signed envelope.

SECURITY MODEL (chiave privata):
  • Il percorso della chiave NON è mai un path fisso dentro il progetto: viene
    risolto da --key oppure dalla variabile d'ambiente SKYRIM_RELEASE_PRIV_KEY_PATH.
    Se il percorso risolto cade DENTRO l'albero del progetto lo script rifiuta.
  • La chiave su disco è SEMPRE cifrata (PKCS8 + BestAvailableEncryption): keygen
    non scrive mai NoEncryption. La passphrase è chiesta a runtime con getpass;
    in CI (non interattiva) può arrivare da SKYRIM_RELEASE_KEY_PASSPHRASE.
  • `encrypt-key` migra una vecchia chiave in chiaro al formato cifrato.

CRITICAL — canonicalization MUST match the JS verifier byte-for-byte:
  json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
and the manifest MUST NOT contain floating-point numbers (JS/Python format them
differently). Use ints and strings only (file_id:int, version:str, counter:int).

Usage:
  python sign_manifest.py keygen      [--priv PATH] [--pub PATH]
  python sign_manifest.py encrypt-key --in OLD_PLAINTEXT.pem [--out NEW.pem]
  python sign_manifest.py sign        manifest.json out.signed.json [--key PATH]
  python sign_manifest.py verify      manifest.signed.json pub.pem

Env:
  SKYRIM_RELEASE_PRIV_KEY_PATH   percorso della chiave privata (fuori dal repo)
  SKYRIM_RELEASE_KEY_PASSPHRASE  passphrase (SOLO per CI; in locale usa il prompt)
"""

import argparse
import getpass
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import (
        Ed25519PrivateKey,
        Ed25519PublicKey,
    )
    from cryptography.hazmat.primitives import serialization
    from cryptography.exceptions import InvalidSignature
except ImportError:
    sys.exit("Manca 'cryptography'. Installa con:  pip install cryptography")

ENV_KEY_PATH = "SKYRIM_RELEASE_PRIV_KEY_PATH"
ENV_PASSPHRASE = "SKYRIM_RELEASE_KEY_PASSPHRASE"
PROJECT_ROOT = Path(__file__).resolve().parent.parent


# ── Risoluzione sicura della chiave privata ──────────────────────────────────

def resolve_key_path(cli_value: str | None, *, must_exist: bool) -> Path:
    """--key vince; altrimenti l'env var. Mai un default dentro il progetto."""
    raw = cli_value or os.environ.get(ENV_KEY_PATH)
    if not raw:
        sys.exit(
            "Percorso chiave privata non specificato.\n"
            f"Imposta {ENV_KEY_PATH} (consigliato) oppure passa --key PATH.\n"
            f"Esempio:  set {ENV_KEY_PATH}=%USERPROFILE%\\.skyrim-release-keys\\release_priv.pem"
        )
    path = Path(raw).expanduser().resolve()
    try:
        path.relative_to(PROJECT_ROOT)
        sys.exit(
            f"RIFIUTATO: la chiave privata ({path}) è DENTRO l'albero del progetto.\n"
            "Spostala fuori dal repository (es. %USERPROFILE%\\.skyrim-release-keys\\) "
            "e aggiorna il percorso."
        )
    except ValueError:
        pass  # fuori dal progetto: ok
    if must_exist and not path.is_file():
        sys.exit(f"Chiave privata non trovata: {path}")
    return path


def get_passphrase(*, confirm: bool) -> bytes:
    """Passphrase da env (CI) o prompt sicuro. Mai da argv (visibile in `ps`)."""
    from_env = os.environ.get(ENV_PASSPHRASE)
    if from_env:
        return from_env.encode("utf-8")
    first = getpass.getpass("Passphrase chiave privata: ")
    if not first:
        sys.exit("Passphrase vuota non ammessa: la chiave su disco deve essere cifrata.")
    if confirm:
        second = getpass.getpass("Conferma passphrase: ")
        if first != second:
            sys.exit("Le passphrase non coincidono.")
    return first.encode("utf-8")


def load_private_key(path: Path) -> Ed25519PrivateKey:
    data = path.read_bytes()
    if b"ENCRYPTED" not in data:
        print(
            f"⚠ ATTENZIONE: la chiave {path} è IN CHIARO su disco.\n"
            "  Migrala subito:  python sign_manifest.py encrypt-key --in "
            f"{path}",
            file=sys.stderr,
        )
        key = serialization.load_pem_private_key(data, password=None)
    else:
        key = serialization.load_pem_private_key(data, password=get_passphrase(confirm=False))
    if not isinstance(key, Ed25519PrivateKey):
        sys.exit("La chiave fornita non è Ed25519")
    return key


def write_private_key(key: Ed25519PrivateKey, path: Path, passphrase: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.BestAvailableEncryption(passphrase),
        )
    )


# ── Canonicalizzazione (identica al verificatore JS) ─────────────────────────

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


# ── Comandi ──────────────────────────────────────────────────────────────────

def keygen(priv_arg: str | None, pub_arg: str | None):
    priv_path = resolve_key_path(priv_arg, must_exist=False)
    if priv_path.exists():
        sys.exit(f"RIFIUTATO: {priv_path} esiste già — non sovrascrivo una chiave di firma.")
    pub_path = Path(pub_arg) if pub_arg else PROJECT_ROOT / "docs" / "keys" / "release_pub.pem"
    passphrase = get_passphrase(confirm=True)

    key = Ed25519PrivateKey.generate()
    write_private_key(key, priv_path, passphrase)
    pub_path.parent.mkdir(parents=True, exist_ok=True)
    pub_path.write_bytes(
        key.public_key().public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
    )
    print(f"keypair generato → {priv_path} (CIFRATA) / {pub_path}")
    print("Incolla il contenuto della chiave PUBBLICA in PINNED_PUBLIC_KEY_PEM (electron/delta/pinnedKey.ts)")


def encrypt_key(in_arg: str, out_arg: str | None):
    """Migra una chiave in chiaro → PKCS8 cifrata (BestAvailableEncryption)."""
    src = Path(in_arg).expanduser().resolve()
    if not src.is_file():
        sys.exit(f"File non trovato: {src}")
    data = src.read_bytes()
    if b"ENCRYPTED" in data:
        sys.exit(f"{src} risulta già cifrata: niente da fare.")
    key = serialization.load_pem_private_key(data, password=None)
    if not isinstance(key, Ed25519PrivateKey):
        sys.exit("La chiave fornita non è Ed25519")

    dest = resolve_key_path(out_arg, must_exist=False)
    passphrase = get_passphrase(confirm=True)
    write_private_key(key, dest, passphrase)
    print(f"chiave cifrata scritta → {dest}")
    print(f"ORA CANCELLA l'originale in chiaro:  {src}")
    print("(e svuota il cestino / usa una cancellazione sicura se disponibile)")


def sign(manifest_path: str, out_path: str, key_arg: str | None):
    manifest = json.load(open(manifest_path, encoding="utf-8"))
    _reject_floats(manifest)
    # bump the monotonic anti-replay counter and stamp publish time
    manifest["release_counter"] = int(manifest.get("release_counter", 0)) + 1
    manifest["published_at"] = datetime.now(timezone.utc).isoformat()

    payload = canonical(manifest)
    digest = hashlib.sha256(payload).hexdigest()
    key = load_private_key(resolve_key_path(key_arg, must_exist=True))
    sig = key.sign(payload).hex()

    envelope = {"manifest": manifest, "sha256": digest, "sig_ed25519": sig}
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(envelope, f, ensure_ascii=False, separators=(",", ":"))
    print(
        f"firmato → {out_path}  (counter={manifest['release_counter']}, "
        f"sha256={digest[:12]}…, mods={len(manifest.get('mods', []))})"
    )


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
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    k = sub.add_parser("keygen", help="genera un nuovo keypair (privata SEMPRE cifrata)")
    k.add_argument("--priv", help=f"percorso chiave privata (default: ${ENV_KEY_PATH})")
    k.add_argument("--pub", help="percorso chiave pubblica (default: docs/keys/release_pub.pem)")

    e = sub.add_parser("encrypt-key", help="migra una chiave in chiaro al formato cifrato")
    e.add_argument("--in", dest="src", required=True, help="chiave privata IN CHIARO da migrare")
    e.add_argument("--out", help=f"destinazione cifrata (default: ${ENV_KEY_PATH})")

    s = sub.add_parser("sign", help="firma un manifest")
    s.add_argument("manifest")
    s.add_argument("out")
    s.add_argument("--key", help=f"percorso chiave privata (default: ${ENV_KEY_PATH})")

    v = sub.add_parser("verify", help="verifica un manifest firmato")
    v.add_argument("signed")
    v.add_argument("pub")

    a = p.parse_args()
    if a.cmd == "keygen":
        keygen(a.priv, a.pub)
    elif a.cmd == "encrypt-key":
        encrypt_key(a.src, a.out)
    elif a.cmd == "sign":
        sign(a.manifest, a.out, a.key)
    elif a.cmd == "verify":
        verify(a.signed, a.pub)


if __name__ == "__main__":
    main()
