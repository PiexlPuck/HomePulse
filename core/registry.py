"""External plugin repository registry store (memory + optional PostgreSQL)."""

from datetime import datetime, timezone
import logging
import re
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger("homepulse-registry")

REPO_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,63}$")


class PluginRegistryStore:
    """Stores external plugin repository URLs with DB-optional fallback."""

    def __init__(self, pool_getter: Optional[Callable[[], Any]] = None):
        self._pool_getter = pool_getter
        self._repos: Dict[str, Dict[str, Any]] = {}

    def _pool(self):
        return self._pool_getter() if self._pool_getter else None

    async def load_from_db(self) -> None:
        pool = self._pool()
        if not pool:
            return
        try:
            async with pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT id, name, registry_url, trusted, enabled, created_at FROM plugin_repositories ORDER BY created_at ASC;"
                )
                for r in rows:
                    self._repos[r["id"]] = {
                        "id": r["id"],
                        "name": r["name"],
                        "registry_url": r["registry_url"],
                        "trusted": bool(r["trusted"]),
                        "enabled": bool(r["enabled"]),
                        "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                    }
        except Exception as exc:
            logger.error(f"Failed loading plugin repositories from DB: {exc}")

    async def list_repositories(self) -> List[Dict[str, Any]]:
        return [dict(self._repos[k]) for k in sorted(self._repos.keys())]

    async def register_repository(
        self,
        repo_id: str,
        name: str,
        registry_url: str,
        trusted: bool = False,
        enabled: bool = True,
    ) -> Dict[str, Any]:
        rid = str(repo_id or "").strip()
        if not REPO_ID_RE.match(rid):
            raise ValueError("Repository id must match ^[a-z0-9][a-z0-9-]{1,63}$")
        url = str(registry_url or "").strip()
        if not (url.startswith("https://") or url.startswith("http://127.0.0.1") or url.startswith("http://localhost")):
            raise ValueError("registry_url must use https:// (or localhost for local development)")

        now_iso = datetime.now(timezone.utc).isoformat()
        rec = {
            "id": rid,
            "name": str(name or rid).strip(),
            "registry_url": url,
            "trusted": bool(trusted),
            "enabled": bool(enabled),
            "created_at": now_iso,
        }
        self._repos[rid] = rec

        pool = self._pool()
        if pool:
            try:
                async with pool.acquire() as conn:
                    await conn.execute(
                        """INSERT INTO plugin_repositories (id, name, registry_url, trusted, enabled)
                           VALUES ($1, $2, $3, $4, $5)
                           ON CONFLICT (id) DO UPDATE SET
                               name = EXCLUDED.name,
                               registry_url = EXCLUDED.registry_url,
                               trusted = EXCLUDED.trusted,
                               enabled = EXCLUDED.enabled;""",
                        rid,
                        rec["name"],
                        rec["registry_url"],
                        rec["trusted"],
                        rec["enabled"],
                    )
            except Exception as exc:
                logger.error(f"DB register_repository error for {rid}: {exc}")

        return dict(rec)

    async def delete_repository(self, repo_id: str) -> bool:
        rid = str(repo_id or "").strip()
        existed = self._repos.pop(rid, None) is not None
        pool = self._pool()
        if pool:
            try:
                async with pool.acquire() as conn:
                    res = await conn.execute("DELETE FROM plugin_repositories WHERE id = $1;", rid)
                    existed = existed or res.endswith("1")
            except Exception as exc:
                logger.error(f"DB delete_repository error for {rid}: {exc}")
        return existed
