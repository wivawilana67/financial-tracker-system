# One image for the API, the migrate job and (later) the nightly job.
#   docker build --target test .   runs the test suite inside the image
#   docker build .                 builds the runtime image (final stage)

FROM python:3.14-slim AS base
COPY --from=ghcr.io/astral-sh/uv:0.13.8 /uv /bin/uv
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH=/opt/venv/bin:$PATH
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

FROM base AS test
RUN uv sync --frozen --no-install-project
COPY . .
RUN pytest

FROM base AS runtime
COPY . .
RUN DJANGO_SECRET_KEY=collectstatic-only python manage.py collectstatic --noinput \
    && useradd --uid 10001 --create-home app
USER app
ARG APP_VERSION=local
ENV APP_ENV=local APP_VERSION=$APP_VERSION PORT=8080
EXPOSE 8080
# Cloud Run sets PORT and APP_ENV. Request logs come from core.middleware, not gunicorn.
CMD ["sh", "-c", "exec gunicorn config.wsgi:application --bind 0.0.0.0:${PORT} --workers 2 --threads 4 --timeout 120"]
