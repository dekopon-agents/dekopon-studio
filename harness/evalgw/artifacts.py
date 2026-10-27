"""Published, checksum-pinned runtime artifacts in an operator cache. There is no source build."""

from __future__ import annotations

import os
import shutil
import tarfile
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .bundle import sha256

USER_AGENT = "dekopon-coordinator (campaign-trail)"
DEKOPON_VERSION = "0.62.0"
DEKOPON_COMMIT = "916796e0d65ef05b488d8aa64fe62899f31d3739"
DAEMONS = ("dekopon-gatewayd", "dekopon-brokerd")
# The Collector writes OTLP JSON with its `file` exporter; the daemons send OTLP/HTTP protobuf.
COLLECTOR_IMAGE = (
    "otel/opentelemetry-collector-contrib:0.137.0"
    "@sha256:886722fe0f37af9d1fe24d29529253ec59fbf263b3b1df4facaf221373e19d23"
)


@dataclass(frozen=True)
class Pinned:
    name: str
    version: str
    url: str
    sha256: str
    source: dict[str, str]


DEKOPON = Pinned(
    name=f"dekopon-{DEKOPON_VERSION}-x86_64-unknown-linux-gnu.tar.gz",
    version=DEKOPON_VERSION,
    url=(
        "https://github.com/dekopon-agents/dekopon/releases/download/"
        f"v{DEKOPON_VERSION}/dekopon-{DEKOPON_VERSION}-x86_64-unknown-linux-gnu.tar.gz"
    ),
    sha256="5d70317ccdb60f7ea472152c543c1813ae1697686a401f6e856b8417d5bf7dc8",
    source={"repository": "dekopon-agents/dekopon", "commit": DEKOPON_COMMIT},
)
PROVIDERS = {
    "gh": Pinned(
        name="gh-provider.wasm",
        version="0.10.0",
        url="https://github.com/dekopon-agents/dekopon-provider-gh/releases/download/v0.10.0/gh-provider.wasm",
        sha256="b5bd0a56dcd6e0731411d445d5209590793d9505f5e566309559a83d1f3aeb1e",
        source={"repository": "dekopon-agents/dekopon-provider-gh", "commit": "0a241d2686ca16ac4cbe2ecf1b07ccfa473acd08"},
    ),
}


class ArtifactError(RuntimeError):
    pass


def fetch(pinned: Pinned, cache: Path) -> Path:
    """The cached artifact, downloaded once and verified against its pin on every use."""
    cache.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = cache / pinned.sha256 / pinned.name
    if not path.is_file():
        path.parent.mkdir(mode=0o700, exist_ok=True)
        partial = path.with_name(path.name + ".partial")
        request = urllib.request.Request(pinned.url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=120) as response, partial.open("wb") as handle:
            shutil.copyfileobj(response, handle)
        os.replace(partial, path)
    actual = sha256(path)
    if actual != pinned.sha256:
        raise ArtifactError(f"{pinned.name} digest {actual} does not match pin {pinned.sha256}")
    return path


def daemons(cache: Path) -> dict[str, Path]:
    """Both daemon executables from the verified release archive."""
    archive = fetch(DEKOPON, cache)
    root = archive.parent / "extracted"
    if not root.is_dir():
        staging = archive.parent / "extracted.partial"
        shutil.rmtree(staging, ignore_errors=True)
        staging.mkdir(mode=0o700)
        with tarfile.open(archive) as tar:
            tar.extractall(staging, filter="data")
        os.replace(staging, root)
    directory = root / DEKOPON.name.removesuffix(".tar.gz")
    found = {name: directory / name for name in DAEMONS}
    for name, path in found.items():
        if not path.is_file():
            raise ArtifactError(f"{DEKOPON.name} has no {name}")
    return found


def describe(pinned: Pinned, path: Path) -> dict[str, Any]:
    return {
        "name": pinned.name,
        "version": pinned.version,
        "source": pinned.source,
        "sha256": sha256(path),
    }
