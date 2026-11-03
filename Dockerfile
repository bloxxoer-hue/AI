# браузеры И системные библиотеки уже внутри образа — никаких install на сборке,
# поэтому на Render не бывает ошибок вида "Executable doesn't exist" / "su: failure"
FROM mcr.microsoft.com/playwright/python:v1.49.1-jammy

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV HEADLESS=1
EXPOSE 10000

CMD sh -c "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-10000}"
