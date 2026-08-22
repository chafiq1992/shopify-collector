from backend.app.main import build_query_string


def _query_for(status_filter: str) -> str:
    return build_query_string(
        base_query="",
        status_filter=status_filter,
        tag_filter=None,
        search=None,
        cod_date=None,
    ).strip()


def test_m3tla_filter_matches_open_unfulfilled_orders_tagged_m3():
    assert _query_for("m3tla") == "status:open fulfillment_status:unfulfilled tag:m3"


def test_urgent_filter_remains_unchanged():
    assert _query_for("urgent") == "status:open fulfillment_status:unfulfilled tag:urgent"
