"""Hook dispatch. Phase 1 implements."""


def dispatch(event: str, payload: dict) -> dict:
    """Dispatch a hook event."""
    return {"continue": True}
