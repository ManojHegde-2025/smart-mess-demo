import pandas as pd
import pytest

from src import config as C
from src.features import assert_no_leakage, build_features
from src.predict import ModelBundle, load_latest, predict_meals, InsufficientHistoryError
from src.preprocessing import DataValidationError, clean
from src.synthetic import generate
from src.train import run_training


@pytest.fixture(scope="module")
def raw():
    return generate(days=200, seed=1, messes=("south",))


def test_no_leakage(raw):
    assert_no_leakage(clean(raw)[0])


def test_leak_detector_catches_leak(raw):
    from src import features
    df = clean(raw)[0]
    orig = features._group_features

    def leaky(g, optional):
        out = orig(g, optional)
        out["roll_mean_7"] = out[C.TARGET]  # deliberately peeks at the present
        return out
    features._group_features = leaky
    try:
        with pytest.raises(AssertionError):
            assert_no_leakage(df)
    finally:
        features._group_features = orig


def test_cleaning_reports_not_silent(raw):
    dirty = pd.concat([raw, raw.iloc[:5]]).copy()
    dirty.loc[dirty.index[0], C.DATE] = "not-a-date"
    df, rep = clean(dirty)
    assert rep["invalid_dates_dropped"] >= 1 and rep["rows_raw"] == len(dirty)


def test_missing_required_column():
    with pytest.raises(DataValidationError):
        clean(pd.DataFrame({"date": ["2026-01-01"], "mess_id": ["s"]}))


def test_cold_start_baseline_only(tmp_path):
    meta = run_training(generate(days=30, messes=("south",)), out_root=tmp_path / "m", reports_root=tmp_path / "r")
    assert meta["mode"] == "baseline"
    b = load_latest(tmp_path / "m")
    out = predict_meals({"mess_id": "south", "date": "2025-07-31", "meal_type": "lunch"}, history=generate(days=30, messes=("south",)), bundle=b)
    assert out["method"] == "moving_average_7"


def test_train_and_predict(raw, tmp_path):
    meta = run_training(raw, out_root=tmp_path / "m", reports_root=tmp_path / "r", data_label="synthetic", run_cv=False)
    assert meta["version"] == "xgb_v1" and meta["mode"] in ("xgboost", "baseline")
    assert run_training(raw, out_root=tmp_path / "m", reports_root=tmp_path / "r", run_cv=False)["version"] == "xgb_v2"
    b = load_latest(tmp_path / "m")
    nxt = (pd.to_datetime(raw[C.DATE]).max() + pd.Timedelta(days=1)).date().isoformat()
    out = predict_meals({"mess_id": "South", "date": nxt, "meal_type": "Lunch", "active_students": 900, "approved_leave": 60},
                        history=raw, bundle=b)
    assert out["model_version"] == "xgb_v2" and out["predicted_meals"] > 0
    assert out["recommended_preparation"] >= out["predicted_meals"]
    with pytest.raises(InsufficientHistoryError):
        predict_meals({"mess_id": "nowhere", "date": nxt, "meal_type": "lunch"}, history=raw, bundle=b)


def test_buffer_rounding():
    from src.predict import _apply_buffer
    assert _apply_buffer(750, 0.02) == 765 and _apply_buffer(752, 0.02) == 767


def test_postgres_history_query_targets_existing_attendance_schema():
    from src import config as C

    query = C.HISTORY_SQL.lower()
    assert "from meal_logs" in query
    assert "join messes" in query
    assert "as served_meals" in query
    assert "group by" in query
    assert "where m.code is not null" in query
    assert "date >" not in query and "date <" not in query


def test_postgres_history_query_returns_expected_shape_and_join_aggregates():
    from sqlalchemy import create_engine, text
    from src import config as C

    engine = create_engine("sqlite:///:memory:")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE messes (id INTEGER PRIMARY KEY, code TEXT)"))
        connection.execute(text("CREATE TABLE meal_logs (mess_id INTEGER, meal_date DATE, meal_period TEXT)"))
        connection.execute(text("INSERT INTO messes VALUES (1, ' North '), (2, 'south'), (3, NULL)"))
        connection.execute(text("INSERT INTO meal_logs VALUES (1, '2026-10-01', 'Lunch'), (1, '2026-10-01', 'lunch'), (2, '2026-10-02', 'dinner'), (99, '2026-10-03', 'lunch'), (3, '2026-10-04', 'breakfast')"))
        result = pd.read_sql(text(C.HISTORY_SQL), connection)

    assert list(result.columns) == ["mess_id", "date", "meal_type", "served_meals"]
    assert result[["mess_id", "meal_type", "served_meals"]].to_dict("records") == [
        {"mess_id": "north", "meal_type": "lunch", "served_meals": 2},
        {"mess_id": "south", "meal_type": "dinner", "served_meals": 1},
    ]


def test_postgres_history_query_targets_existing_attendance_schema():
    from src import config as C

    query = C.HISTORY_SQL.lower()
    assert "from meal_logs" in query
    assert "join messes" in query
    assert "as mess_id" in query
    assert "as date" in query
    assert "as meal_type" in query
    assert "as served_meals" in query
    assert "group by" in query
    assert "where m.code is not null" in query
    assert "date >" not in query and "date <" not in query
    assert "mess_usage" not in query


def test_postgres_history_provider_uses_configured_sql(monkeypatch):
    import pandas as pd
    import sqlalchemy
    from src.history import PostgresHistoryProvider

    calls = {}

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    class Engine:
        def connect(self):
            return Connection()

    def create_engine(dsn, **kwargs):
        calls["dsn"] = dsn
        calls["kwargs"] = kwargs
        return Engine()

    def read_sql(query, connection):
        calls["query"] = str(query)
        return pd.DataFrame({"mess_id": ["north"], "date": ["2026-10-01"],
                             "meal_type": ["lunch"], "served_meals": [3]})

    monkeypatch.setattr(sqlalchemy, "create_engine", create_engine)
    monkeypatch.setattr(pd, "read_sql", read_sql)
    result = PostgresHistoryProvider("postgresql://readonly", "SELECT 1").load()
    assert calls["query"] == "SELECT 1"
    assert calls["kwargs"]["pool_pre_ping"] is True
    assert result.iloc[0]["mess_id"] == "north"
    assert result.iloc[0]["meal_type"] == "lunch"


def test_history_diagnostics_reports_only_aggregates_and_normalized_metadata():
    from src.history import CachedProvider

    raw = pd.DataFrame({
        "mess_id": [" North ", "NORTH", "south"],
        "date": ["2026-10-01", "2026-10-02", "2026-10-03"],
        "meal_type": ["Lunch", "lunch", "DINNER"],
        "served_meals": [2, 4, 1],
        "student_id": [101, 102, 103],
    })

    class Provider:
        def load(self):
            return raw

    report = CachedProvider(Provider()).diagnostics()
    assert report["row_count"] == 3
    assert report["date_min"] == "2026-10-01"
    assert report["date_max"] == "2026-10-03"
    assert {"mess_id", "date", "meal_type", "served_meals", "student_id"} == set(report["columns"])
    assert report["groups"] == [
        {"mess_id": "north", "meal_type": "lunch", "row_count": 2, "total_count": 6},
        {"mess_id": "south", "meal_type": "dinner", "row_count": 1, "total_count": 1},
    ]
    assert all("student_id" not in group for group in report["groups"])
    assert all(value not in str(report) for value in ("101", "102", "103"))
