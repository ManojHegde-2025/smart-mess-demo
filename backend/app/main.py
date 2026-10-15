from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import models  # noqa: F401  (registers tables with Base)
from app.config import settings
from app.database import Base, engine
from app.manager_api import router as manager_router
from app.routes import router


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Dev convenience. In shared environments, apply schema.sql instead.
    Base.metadata.create_all(bind=engine)
    yield


app = FastAPI(title="Mess Attendance API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router, prefix="/api/v1")
app.include_router(manager_router, prefix="/api/v1")


@app.get("/health")
def health():
    return {"status": "ok"}
