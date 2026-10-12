"""Verify generated packages without executing graphics."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import sys
import zipfile


def verify(root):
    root = Path(root).resolve()
    report = json.loads((root / "conversion-report.json").read_text(encoding="utf-8"))
    results = []
    if not report.get("templates"):
        raise ValueError("Lot sans modèles à valider.")
    for item in report["templates"]:
        slug = item["slug"]
        if not slug or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in slug):
            raise ValueError("Identifiant de modèle invalide.")
        package = root / item["package"]
        if package.resolve().parent != root:
            raise ValueError("Chemin de package invalide.")
        if hashlib.sha256(package.read_bytes()).hexdigest() != item["sha256"]:
            raise ValueError(f"{slug} : empreinte ZIP incorrecte.")
        with zipfile.ZipFile(package) as archive:
            names = archive.namelist()
            if len(names) != len(set(names)):
                raise ValueError("Entrées ZIP dupliquées.")
            for name in names:
                relative = PurePosixPath(name)
                if relative.is_absolute() or ".." in relative.parts or "\\" in name or ":" in name:
                    raise ValueError("Chemin ZIP invalide.")
                original = root / "sources" / slug / name
                if archive.read(name) != original.read_bytes():
                    raise ValueError(f"{slug} : ressource différente : {name}")
            manifest = json.loads(archive.read(slug + ".ograf.json"))
            if manifest["main"] not in names:
                raise ValueError("Module principal absent.")
        results.append({"package": item["package"], "sha256": item["sha256"], "verified": True})
    return results


if __name__ == "__main__":
    try:
        print(json.dumps(verify(sys.argv[1]), ensure_ascii=False, indent=2))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
