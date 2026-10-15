from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "postgresql+psycopg://mess:mess@localhost:5432/mess_attendance"
    jwt_secret: str = "dev-only-change-me"
    jwt_expire_minutes: int = 720

    # QR tokens rotate every N seconds; the previous window is also accepted,
    # so a token stays valid for roughly N to 2N seconds.
    qr_secret: str = "dev-only-qr-change-me"
    qr_rotate_seconds: int = 30

    meal_cost: int = 1  # meals debited per successful scan
    cors_origins: list[str] = ["http://localhost:5173"]

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()
