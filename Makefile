PYTHON ?= python3
VENV ?= .venv
VENV_PY = $(VENV)/bin/python

.PHONY: install install-venv fetch features train api pipeline doctor docs

install:
	$(PYTHON) -m pip install -r requirements.txt

install-venv:
	$(PYTHON) -m venv $(VENV)
	$(VENV_PY) -m pip install --upgrade pip
	$(VENV_PY) -m pip install -r requirements.txt
	@echo "Aktifleştir: source $(VENV)/bin/activate"

doctor:
	@echo "Kullanılan Python: $$(command -v $(PYTHON))"
	@$(PYTHON) -c "import sys; print(sys.executable)"
	@$(PYTHON) -c "import importlib.metadata as m; print('flask', m.version('flask'))"

fetch:
	$(PYTHON) -m src.data.fetch

features:
	$(PYTHON) src/features/build_features.py

train:
	$(PYTHON) main.py

api:
	$(PYTHON) src/api/app.py

pipeline: fetch features train

docs:
	@echo "Jüri / rapor: docs/RAPOR.md"
	@echo "Repo giriş:  README.md"
